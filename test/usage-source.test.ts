import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Credentials } from '../src/credentials.js';
import { usageError, type UsageError } from '../src/errors.js';
import { err, ok, type Result } from '../src/result.js';
import type { UsagePayload } from '../src/usage-api.js';
import { FORCE_FLOOR_MS, UsageSource } from '../src/usage-source.js';

const TOKEN = 'sk-ant-oat01-SOURCE-TEST';
const T0 = Date.parse('2026-10-07T15:20:47Z');
const MAX_AGE = 60_000;

function payload(percent: number): UsagePayload {
  return { limits: [{ kind: 'session', group: 'session', percent, severity: 'normal', resets_at: null }] };
}

function credentials(overrides: Partial<Credentials> = {}): Credentials {
  return {
    accessToken: TOKEN,
    expiresAt: new Date(T0 + 8 * 3_600_000),
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    source: 'keychain',
    ...overrides,
  };
}

class Harness {
  clock = T0;
  fetchCalls = 0;
  credentialsResult: Result<Credentials, UsageError> = ok(credentials());
  responses: Array<Result<UsagePayload, UsageError>> = [];
  gate: Promise<void> | null = null;

  source(cacheFile: string | null = null, maxAgeMs = MAX_AGE): UsageSource {
    return new UsageSource({
      maxAgeMs,
      cacheFile,
      deps: {
        readCredentials: async () => this.credentialsResult,
        readAccount: async () => ({ email: 'dev@example.com', displayName: null }),
        now: () => this.clock,
        fetchUsage: async () => {
          this.fetchCalls += 1;
          if (this.gate) await this.gate;
          return this.responses.shift() ?? ok(payload(this.fetchCalls));
        },
      },
    });
  }
}

let h: Harness;
beforeEach(() => {
  h = new Harness();
});

describe('UsageSource', () => {
  it('fetches once and serves the payload with plan, account and token expiry', async () => {
    const snapshot = await h.source().get();
    expect(h.fetchCalls).toBe(1);
    expect(snapshot).toMatchObject({
      payload: payload(1),
      error: null,
      plan: 'Max 20x',
      account: { email: 'dev@example.com' },
    });
    expect(snapshot.fetchedAt?.getTime()).toBe(T0);
    expect(snapshot.tokenExpiresAt?.getTime()).toBe(T0 + 8 * 3_600_000);
  });

  it('reuses the payload inside maxAge and refetches after it', async () => {
    const source = h.source();
    await source.get();
    h.clock += MAX_AGE - 1;
    expect((await source.get()).payload).toEqual(payload(1));
    expect(h.fetchCalls).toBe(1);
    h.clock += 1;
    expect((await source.get()).payload).toEqual(payload(2));
    expect(h.fetchCalls).toBe(2);
  });

  it('lets force bypass maxAge, but not the 5s floor', async () => {
    const source = h.source();
    await source.get();
    h.clock += FORCE_FLOOR_MS - 1;
    await source.get({ force: true });
    expect(h.fetchCalls).toBe(1);
    h.clock += 1;
    await source.get({ force: true });
    expect(h.fetchCalls).toBe(2);
  });

  it('dedupes concurrent calls into one request', async () => {
    let release = (): void => undefined;
    h.gate = new Promise((resolve) => {
      release = resolve;
    });
    const source = h.source();
    const pending = [source.get(), source.get({ force: true }), source.get()];
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const results = await Promise.all(pending);
    expect(h.fetchCalls).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it('keeps the last good payload next to an error', async () => {
    const source = h.source();
    await source.get();
    h.clock += MAX_AGE;
    h.responses.push(err(usageError('upstream_error', 'A API do Claude falhou (HTTP 500).')));
    const snapshot = await source.get();
    expect(snapshot.error?.code).toBe('upstream_error');
    expect(snapshot.payload).toEqual(payload(1));
    expect(snapshot.fetchedAt?.getTime()).toBe(T0);
  });

  it('backs off after a 429 for Retry-After, then tries again', async () => {
    const source = h.source(null, 10_000);
    h.responses.push(err(usageError('rate_limited', '429', null, 120_000)));
    expect((await source.get()).error?.code).toBe('rate_limited');
    expect(h.fetchCalls).toBe(1);

    h.clock += 60_000;
    const during = await source.get({ force: true });
    expect(h.fetchCalls).toBe(1);
    expect(during.error?.code).toBe('rate_limited');
    expect(during.error?.retryAfterMs).toBe(60_000);

    h.clock += 60_000;
    expect((await source.get()).error).toBeNull();
    expect(h.fetchCalls).toBe(2);
  });

  it('refreshes instead of freezing when the clock goes back', async () => {
    const source = h.source();
    await source.get();
    h.clock -= 10 * 60_000;
    expect((await source.get()).payload).toEqual(payload(2));
    expect(h.fetchCalls).toBe(2);
  });

  it('does not call the API with an expired token (30s skew)', async () => {
    h.credentialsResult = ok(credentials({ expiresAt: new Date(T0 + 29_000) }));
    const snapshot = await h.source().get();
    expect(h.fetchCalls).toBe(0);
    expect(snapshot.error?.code).toBe('token_expired');
    expect(snapshot.error?.hint).toContain('`claude`');
    expect(snapshot.tokenExpiresAt?.getTime()).toBe(T0 + 29_000);
  });

  it('calls the API when expiry is unknown', async () => {
    h.credentialsResult = ok(credentials({ expiresAt: null }));
    expect((await h.source().get()).error).toBeNull();
    expect(h.fetchCalls).toBe(1);
  });

  it('surfaces credential errors without calling the API', async () => {
    h.credentialsResult = err(usageError('no_credentials', 'Nenhum login do Claude Code encontrado.'));
    const snapshot = await h.source().get();
    expect(h.fetchCalls).toBe(0);
    expect(snapshot).toMatchObject({ payload: null, plan: null, error: { code: 'no_credentials' } });
  });
});

describe('UsageSource cache file', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-usage-cache-'));
    file = join(dir, 'nested', 'last.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists owner-only, without credentials, and is shared across instances', async () => {
    await h.source(file).get();
    const info = await stat(file);
    expect(info.mode & 0o777).toBe(0o600);
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toEqual({ version: 1, fetchedAt: T0, payload: payload(1) });

    h.clock += 10_000;
    const other = await h.source(file).get();
    expect(h.fetchCalls).toBe(1);
    expect(other.payload).toEqual(payload(1));
    expect(other.error).toBeNull();
  });

  it('shows the cached payload when the token has expired since', async () => {
    await h.source(file).get();
    h.clock += 2 * 3_600_000;
    h.credentialsResult = ok(credentials({ expiresAt: new Date(h.clock - 1) }));
    const snapshot = await h.source(file).get();
    expect(snapshot.error?.code).toBe('token_expired');
    expect(snapshot.payload).toEqual(payload(1));
  });

  it('ignores a corrupt or foreign cache file', async () => {
    await h.source(file).get();
    await writeFile(file, '{"version":2,"fetchedAt":"x"}');
    h.clock += 1_000;
    expect((await h.source(file).get()).payload).toEqual(payload(2));
    await writeFile(file, 'not json');
    h.clock += 1_000;
    expect((await h.source(file).get()).payload).toEqual(payload(3));
  });

  it('shares a 429 backoff with every process using the cache dir', async () => {
    h.responses.push(err(usageError('rate_limited', '429', null, 120_000)));
    expect((await h.source(file, 10_000).get()).error?.code).toBe('rate_limited');
    const backoff = join(dir, 'nested', 'backoff.json');
    expect((await stat(backoff)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(backoff, 'utf8'))).toEqual({ version: 1, until: T0 + 120_000 });

    h.clock += 30_000;
    const other = await h.source(file, 10_000).get({ force: true });
    expect(h.fetchCalls).toBe(1);
    expect(other.error).toMatchObject({ code: 'rate_limited', retryAfterMs: 90_000, hint: 'Próxima consulta liberada em 1 min.' });

    h.clock += 90_000;
    expect((await h.source(file, 10_000).get()).error).toBeNull();
    expect(h.fetchCalls).toBe(2);
  });

  it('ignores a backoff file that is junk or absurdly far out', async () => {
    const backoff = join(dir, 'nested', 'backoff.json');
    await h.source(file).get();
    await writeFile(backoff, JSON.stringify({ version: 1, until: T0 + 10 * 3_600_000 }));
    h.clock += 60_000;
    expect((await h.source(file).get()).error).toBeNull();
    await writeFile(backoff, '{"until":"soon"}');
    h.clock += 60_000;
    expect((await h.source(file).get()).error).toBeNull();
    expect(h.fetchCalls).toBe(3);
  });

  it('survives an unwritable cache location', async () => {
    await writeFile(join(dir, 'blocker'), '');
    const snapshot = await h.source(join(dir, 'blocker', 'last.json')).get();
    expect(snapshot.error).toBeNull();
    expect(snapshot.payload).toEqual(payload(1));
  });
});

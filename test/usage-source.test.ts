import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Credentials } from '../src/credentials.js';
import { rateLimitedError, usageError, type UsageError } from '../src/errors.js';
import { err, ok, type Result } from '../src/result.js';
import type { UsagePayload } from '../src/usage-api.js';
import { BASE_HOLD_MS, FORCE_FLOOR_MS, holdMs, SHARED_READ_MS, UsageSource } from '../src/usage-source.js';

const TOKEN = 'sk-ant-oat01-SOURCE-TEST';
const T0 = Date.parse('2026-10-07T15:20:47Z');
const MAX_AGE = 60_000;
const MIN = 60_000;

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

  it('lets force bypass maxAge, but not a read under a minute old nor the 5s floor', async () => {
    const source = h.source(null, 5 * MIN);
    await source.get();
    h.clock += SHARED_READ_MS - 1;
    expect((await source.get({ force: true })).error).toBeNull();
    expect(h.fetchCalls).toBe(1);
    h.clock += FORCE_FLOOR_MS;
    h.responses.push(err(usageError('upstream_error', 'A API do Claude falhou (HTTP 500).')));
    expect((await source.get({ force: true })).error?.code).toBe('upstream_error');
    expect(h.fetchCalls).toBe(2);
    h.clock += FORCE_FLOOR_MS - 1;
    await source.get({ force: true });
    expect(h.fetchCalls).toBe(2);
    h.clock += 1;
    await source.get({ force: true });
    expect(h.fetchCalls).toBe(3);
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

  it.each([[0], [null]])('holds 5 min after a 429 with Retry-After %j, then tries again (the 2026-10-09 loop)', async (retryAfterMs) => {
    const source = h.source(null, MAX_AGE);
    h.responses.push(err(rateLimitedError(retryAfterMs)));
    const first = await source.get();
    expect(first.error?.code).toBe('rate_limited');
    expect(first.retryAt?.getTime()).toBe(T0 + BASE_HOLD_MS);

    h.clock += MAX_AGE;
    const during = await source.get({ force: true });
    expect(h.fetchCalls).toBe(1);
    expect(during).toMatchObject({ error: { code: 'rate_limited' }, retryAt: new Date(T0 + BASE_HOLD_MS) });

    h.clock = T0 + BASE_HOLD_MS;
    expect(await source.get()).toMatchObject({ error: null, retryAt: null });
    expect(h.fetchCalls).toBe(2);
  });

  it('doubles the hold for 429s in a row up to 30 min, and starts over after a good read', async () => {
    const source = h.source(null, 10_000);
    const holds = [5, 10, 20, 30, 30].map((minutes) => minutes * MIN);
    for (const hold of holds) {
      h.responses.push(err(rateLimitedError(null)));
      const at = h.clock;
      expect((await source.get()).retryAt?.getTime()).toBe(at + hold);
      h.clock = at + hold;
    }
    expect((await source.get()).error).toBeNull();
    h.clock += 10_000;
    h.responses.push(err(rateLimitedError(null)));
    expect((await source.get()).retryAt?.getTime()).toBe(h.clock + BASE_HOLD_MS);
    expect(h.fetchCalls).toBe(7);
  });

  // -w wakes 1-31s past the end (slack + jitter); the web page polls every 30s.
  it.each([[1_000], [31_000]])('keeps the streak when the next 429 comes %i ms after the hold ends', async (late) => {
    const source = h.source(null, 10_000);
    for (const hold of [5, 10, 20].map((minutes) => minutes * MIN)) {
      h.responses.push(err(rateLimitedError(null)));
      const at = h.clock;
      expect((await source.get()).retryAt?.getTime()).toBe(at + hold);
      h.clock = at + hold + late;
    }
  });

  it('waits a longer positive Retry-After, capped at 1h, never less than the doubling hold', () => {
    expect(holdMs(1, 0)).toBe(BASE_HOLD_MS);
    expect(holdMs(1, 30_000)).toBe(BASE_HOLD_MS);
    expect(holdMs(1, 2_461_000)).toBe(2_461_000);
    expect(holdMs(2, 7_200_000)).toBe(3_600_000);
    expect(holdMs(9, null)).toBe(30 * MIN);
    expect(holdMs(500, null)).toBe(30 * MIN);
  });

  it('calls again as soon as a hold ends, not a whole maxAge after the last look', async () => {
    const source = h.source(null, 5 * MIN);
    h.responses.push(err(rateLimitedError(471_000)));
    expect((await source.get()).retryAt?.getTime()).toBe(T0 + 471_000);
    h.clock = T0 + 5 * MIN;
    await source.get();
    expect(h.fetchCalls).toBe(1);
    h.clock = T0 + 471_000;
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

  it('keeps a hold at the 1h cap when the clock steps back a little', async () => {
    const source = h.source();
    h.responses.push(err(rateLimitedError(7_200_000)));
    expect((await source.get()).retryAt?.getTime()).toBe(T0 + 3_600_000);
    h.clock -= 1_000;
    const snapshot = await source.get({ force: true });
    expect(h.fetchCalls).toBe(1);
    expect(snapshot.retryAt?.getTime()).toBe(T0 + 3_600_000);
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

  it('shares a 429 hold with every process using the cache dir', async () => {
    h.responses.push(err(rateLimitedError(null)));
    expect((await h.source(file, 10_000).get()).error?.code).toBe('rate_limited');
    const backoff = join(dir, 'nested', 'backoff.json');
    expect((await stat(backoff)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(backoff, 'utf8'))).toEqual({ version: 1, until: T0 + BASE_HOLD_MS, streak: 1 });

    h.clock += 30_000;
    const other = await h.source(file, 10_000).get({ force: true });
    expect(h.fetchCalls).toBe(1);
    expect(other).toMatchObject({ error: { code: 'rate_limited' }, retryAt: new Date(T0 + BASE_HOLD_MS) });

    h.clock = T0 + BASE_HOLD_MS;
    expect((await h.source(file, 10_000).get()).error).toBeNull();
    expect(h.fetchCalls).toBe(2);
  });

  it('carries the streak across processes and reads a file from before it ({version, until})', async () => {
    const backoff = join(dir, 'nested', 'backoff.json');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(backoff, JSON.stringify({ version: 1, until: T0 + 2 * MIN }));
    expect((await h.source(file).get()).retryAt?.getTime()).toBe(T0 + 2 * MIN);
    expect(h.fetchCalls).toBe(0);

    h.clock = T0 + 2 * MIN;
    h.responses.push(err(rateLimitedError(null)));
    expect((await h.source(file).get()).retryAt?.getTime()).toBe(h.clock + 10 * MIN);
    expect(JSON.parse(await readFile(backoff, 'utf8'))).toEqual({ version: 1, until: h.clock + 10 * MIN, streak: 2 });
  });

  it('ends the streak on a good read another process landed while our 429 was on the wire', async () => {
    const backoff = join(dir, 'nested', 'backoff.json');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(backoff, JSON.stringify({ version: 1, until: T0, streak: 1 }));
    let release = (): void => undefined;
    h.gate = new Promise((resolve) => {
      release = resolve;
    });
    // Both wake as the hold ends; the winner's answer is consumed first, the loser's 429 after it.
    h.responses.push(ok(payload(7)), err(rateLimitedError(0)));
    h.clock = T0 + 1_000;
    const loser = h.source(file).get();
    await vi.waitFor(() => expect(h.fetchCalls).toBe(1));
    h.gate = null;
    h.clock = T0 + 1_200;
    expect((await h.source(file).get()).error).toBeNull();
    h.clock = T0 + 1_400;
    release();
    const snapshot = await loser;
    expect(JSON.parse(await readFile(backoff, 'utf8'))).toEqual({ version: 1, until: T0 + 1_400 + BASE_HOLD_MS, streak: 1 });
    expect(snapshot).toMatchObject({ error: { code: 'rate_limited' }, payload: payload(7) });
  });

  it('starts a new streak when the previous hold ended over an hour ago', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'nested', 'backoff.json'), JSON.stringify({ version: 1, until: T0 - 61 * MIN, streak: 4 }));
    h.responses.push(err(rateLimitedError(null)));
    expect((await h.source(file).get()).retryAt?.getTime()).toBe(T0 + BASE_HOLD_MS);
  });

  it('reports an expired login or a credentials error ahead of a shared 429 hold', async () => {
    h.responses.push(err(rateLimitedError(3_600_000)));
    await h.source(file).get();
    h.clock += 10 * MIN;

    h.credentialsResult = ok(credentials({ expiresAt: new Date(h.clock - 60_000) }));
    const expired = await h.source(file).get();
    expect(expired).toMatchObject({ error: { code: 'token_expired', hint: expect.stringContaining('`claude`') }, retryAt: null });

    h.credentialsResult = err(usageError('keychain_error', 'O Keychain não respondeu.'));
    expect((await h.source(file).get()).error?.code).toBe('keychain_error');

    h.credentialsResult = ok(credentials());
    expect((await h.source(file).get()).error?.code).toBe('rate_limited');
    expect(h.fetchCalls).toBe(1);
  });

  it('still holds on a file whose streak is junk, counting it as one 429', async () => {
    const backoff = join(dir, 'nested', 'backoff.json');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(backoff, JSON.stringify({ version: 1, until: T0 + 2 * MIN, streak: 'x' }));
    expect((await h.source(file).get()).retryAt?.getTime()).toBe(T0 + 2 * MIN);
    expect(h.fetchCalls).toBe(0);

    h.clock = T0 + 2 * MIN;
    h.responses.push(err(rateLimitedError(0)));
    expect((await h.source(file).get()).retryAt?.getTime()).toBe(h.clock + 10 * MIN);
  });

  it('does not hold on a 401, a 5xx or a network error, nor count them in the streak', async () => {
    const source = h.source(file, 10_000);
    for (const error of [
      usageError('unauthorized', 'A API recusou o login (401).'),
      usageError('upstream_error', 'A API do Claude falhou (HTTP 503).'),
      usageError('network_error', 'Sem conexão com api.anthropic.com.'),
    ]) {
      h.responses.push(err(error));
      expect(await source.get()).toMatchObject({ error: { code: error.code }, retryAt: null });
      h.clock += 10_000;
    }
    await expect(stat(join(dir, 'nested', 'backoff.json'))).rejects.toThrow();
    expect(h.fetchCalls).toBe(3);
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

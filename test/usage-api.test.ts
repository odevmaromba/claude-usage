import { describe, expect, it } from 'vitest';
import { fetchUsage, parseRetryAfter, USAGE_URL, type FetchFn } from '../src/usage-api.js';

const TOKEN = 'sk-ant-oat01-TEST-TOKEN';
const NOW = Date.parse('2026-10-07T15:20:47Z');

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function respondWith(response: Response | (() => Promise<Response>)): { fetchFn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response() : response;
  };
  return { fetchFn, calls };
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('fetchUsage', () => {
  it('sends the OAuth bearer with the beta header and refuses redirects', async () => {
    const { fetchFn, calls } = respondWith(json({ limits: [] }));
    const result = await fetchUsage(TOKEN, { fetchFn });
    expect(result).toEqual({ ok: true, value: { limits: [] } });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(USAGE_URL);
    expect(call?.init.method).toBe('GET');
    expect(call?.init.redirect).toBe('error');
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(call?.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20');
    expect(headers.get('user-agent')).toMatch(/^claude-usage\/\d+\.\d+\.\d+$/);
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [500, 'upstream_error'],
    [503, 'upstream_error'],
  ])('maps HTTP %d to %s without leaking the token', async (status, code) => {
    const { fetchFn } = respondWith(json({ error: { message: `bad token ${TOKEN}` } }, { status }));
    const result = await fetchUsage(TOKEN, { fetchFn });
    expect(!result.ok && result.error.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('maps 429 and keeps Retry-After', async () => {
    const { fetchFn } = respondWith(json({}, { status: 429, headers: { 'retry-after': '120' } }));
    const result = await fetchUsage(TOKEN, { fetchFn, now: () => NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('rate_limited');
      expect(result.error.retryAfterMs).toBe(120_000);
    }
  });

  it('defaults the 429 backoff when Retry-After is missing', async () => {
    const { fetchFn } = respondWith(new Response(null, { status: 429 }));
    const result = await fetchUsage(TOKEN, { fetchFn });
    expect(!result.ok && result.error.retryAfterMs).toBe(60_000);
  });

  it('rejects non-JSON and non-object bodies', async () => {
    const html = await fetchUsage(TOKEN, { fetchFn: respondWith(new Response('<html>')).fetchFn });
    expect(!html.ok && html.error.code).toBe('bad_response');
    const array = await fetchUsage(TOKEN, { fetchFn: respondWith(json([1, 2])).fetchFn });
    expect(!array.ok && array.error.code).toBe('bad_response');
    const nul = await fetchUsage(TOKEN, { fetchFn: respondWith(json(null)).fetchFn });
    expect(!nul.ok && nul.error.code).toBe('bad_response');
  });

  it('maps network failures and timeouts', async () => {
    const offline = await fetchUsage(TOKEN, {
      fetchFn: async () => {
        throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
      },
    });
    expect(!offline.ok && offline.error.code).toBe('network_error');

    const slow = await fetchUsage(TOKEN, {
      timeoutMs: 20,
      fetchFn: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });
    expect(!slow.ok && slow.error.code).toBe('timeout');
  });

  it('blames the network, not the payload, when the body stalls or drops', async () => {
    const bodyFailing = (error: Error): FetchFn =>
      respondWith(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(error);
            },
          }),
          { status: 200 },
        ),
      ).fetchFn;
    const stalled = await fetchUsage(TOKEN, { fetchFn: bodyFailing(new DOMException('slow body', 'TimeoutError')) });
    expect(!stalled.ok && stalled.error.code).toBe('timeout');
    const dropped = await fetchUsage(TOKEN, { fetchFn: bodyFailing(new TypeError('terminated')) });
    expect(!dropped.ok && dropped.error.code).toBe('network_error');
  });

  it('states the wait in the 429 hint instead of promising a retry', async () => {
    const { fetchFn } = respondWith(json({}, { status: 429, headers: { 'retry-after': '120' } }));
    const result = await fetchUsage(TOKEN, { fetchFn, now: () => NOW });
    expect(!result.ok && result.error.hint).toBe('Próxima consulta liberada em 2 min.');
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('30', NOW)).toBe(30_000);
    expect(parseRetryAfter(' 0 ', NOW)).toBe(0);
    expect(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90_000);
    expect(parseRetryAfter(new Date(NOW - 90_000).toUTCString(), NOW)).toBe(0);
  });

  it('ignores junk', () => {
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter('', NOW)).toBeNull();
    expect(parseRetryAfter('soon', NOW)).toBeNull();
    expect(parseRetryAfter('-5', NOW)).toBeNull();
  });
});

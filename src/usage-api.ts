import { z } from 'zod';
import { HINTS, rateLimitedError, usageError, type UsageError } from './errors.js';
import { err, ok, type Result } from './result.js';
import { VERSION } from './version.js';

/** Same endpoint Claude Code's `/usage` reads. Undocumented: shape is parsed leniently downstream. */
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;

/** Top level must be a JSON object; each section is validated on its own in usage-view. */
export const UsagePayloadSchema = z.record(z.string(), z.unknown());
export type UsagePayload = z.infer<typeof UsagePayloadSchema>;

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface FetchUsageOptions {
  readonly fetchFn?: FetchFn;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export async function fetchUsage(
  accessToken: string,
  options: FetchUsageOptions = {},
): Promise<Result<UsagePayload, UsageError>> {
  const fetchFn = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA,
        Accept: 'application/json',
        'User-Agent': `claude-usage/${VERSION}`,
      },
      // The bearer token must never follow a redirect to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (cause) {
    return err(transportError(cause));
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return err(httpError(response, (options.now ?? Date.now)()));
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (cause) {
    // The body can stall or drop after the headers arrived: that is the network, not a bad payload.
    if (!(cause instanceof SyntaxError)) return err(transportError(cause));
    return err(usageError('bad_response', 'A API do Claude respondeu algo que não é JSON.', HINTS.retry));
  }
  const parsed = UsagePayloadSchema.safeParse(json);
  if (!parsed.success) {
    return err(usageError('bad_response', 'A API do Claude respondeu num formato inesperado.', HINTS.retry));
  }
  return ok(parsed.data);
}

function transportError(cause: unknown): UsageError {
  if (errorName(cause) === 'TimeoutError') {
    return usageError('timeout', 'A API do Claude não respondeu a tempo.', HINTS.retry);
  }
  return usageError('network_error', 'Sem conexão com api.anthropic.com.', 'Confira a internet/VPN e tente de novo.');
}

function httpError(response: Response, now: number): UsageError {
  const { status } = response;
  if (status === 401) return usageError('unauthorized', 'A API recusou o login (401).', HINTS.renew);
  if (status === 403) return usageError('forbidden', 'O login não tem permissão pra ler o uso (403).', HINTS.login);
  if (status === 429) {
    return rateLimitedError(parseRetryAfter(response.headers.get('retry-after'), now) ?? DEFAULT_RATE_LIMIT_BACKOFF_MS);
  }
  return usageError('upstream_error', `A API do Claude falhou (HTTP ${status}).`, HINTS.retry);
}

/** `Retry-After` as delta-seconds or HTTP-date → milliseconds from `now`. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // HTTP-dates always name a weekday/month; Date.parse would also take "-5" as year -5.
  if (!/[a-z]{3}/i.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function errorName(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('name' in value)) return null;
  return typeof value.name === 'string' ? value.name : null;
}

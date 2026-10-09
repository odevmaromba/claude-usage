import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AccountInfo } from './account.js';
import type { Credentials, CredentialsSource } from './credentials.js';
import { HINTS, rateLimitedError, usageError, type UsageError } from './errors.js';
import { planLabel } from './format.js';
import type { Result } from './result.js';
import { UsagePayloadSchema, type UsagePayload } from './usage-api.js';

export interface Snapshot {
  /** Last good payload: fresh, or stale when `error` is set. */
  readonly payload: UsagePayload | null;
  readonly fetchedAt: Date | null;
  readonly error: UsageError | null;
  readonly plan: string | null;
  readonly tokenExpiresAt: Date | null;
  readonly account: AccountInfo | null;
  /** Where the token came from; `fixture` means the numbers are not the account's. */
  readonly credentialsSource: CredentialsSource | null;
}

export interface SnapshotProvider {
  get(request?: { readonly force?: boolean }): Promise<Snapshot>;
}

export interface UsageSourceDeps {
  readonly readCredentials: () => Promise<Result<Credentials, UsageError>>;
  readonly fetchUsage: (accessToken: string) => Promise<Result<UsagePayload, UsageError>>;
  readonly readAccount: () => Promise<AccountInfo | null>;
  readonly now: () => number;
}

export interface UsageSourceOptions {
  /** Payload younger than this is served without hitting the API (also across processes, via the cache file). */
  readonly maxAgeMs: number;
  /** `null` disables persistence (fixtures, tests). A 429 backoff goes next to it, in `backoff.json`. */
  readonly cacheFile: string | null;
  readonly deps: UsageSourceDeps;
}

/** A forced refresh still waits this long after the previous attempt. */
export const FORCE_FLOOR_MS = 5_000;
/** Treat the token as expired slightly early: the request takes time. */
const EXPIRY_SKEW_MS = 30_000;
const DEFAULT_BACKOFF_MS = 60_000;
/** A backoff further out than this comes from a bad clock or a junk file: ignore it. */
const MAX_BACKOFF_MS = 3_600_000;

const CacheFileSchema = z.object({
  version: z.literal(1),
  fetchedAt: z.number(),
  payload: UsagePayloadSchema,
});

const BackoffFileSchema = z.object({ version: z.literal(1), until: z.number() });

interface CachedPayload {
  readonly payload: UsagePayload;
  readonly fetchedAt: number;
}

/**
 * Owns every call to the usage API: freshness window, in-flight dedupe,
 * 429 backoff and a last-good cache that survives restarts. Errors come back
 * inside the snapshot, next to the last good payload.
 */
export class UsageSource implements SnapshotProvider {
  readonly #options: UsageSourceOptions;
  #cached: CachedPayload | null = null;
  #last: Snapshot | null = null;
  #lastAttemptAt = Number.NEGATIVE_INFINITY;
  #backoffUntil = 0;
  #inflight: Promise<Snapshot> | null = null;

  constructor(options: UsageSourceOptions) {
    this.#options = options;
  }

  get(request: { readonly force?: boolean } = {}): Promise<Snapshot> {
    if (this.#inflight) return this.#inflight;
    const force = request.force === true;
    const floor = force ? FORCE_FLOOR_MS : this.#options.maxAgeMs;
    // Negative elapsed = the clock went back: refresh instead of freezing until it catches up.
    const elapsed = this.#options.deps.now() - this.#lastAttemptAt;
    if (this.#last && elapsed >= 0 && elapsed < floor) return Promise.resolve(this.#last);
    this.#inflight = this.#refresh(force).finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #refresh(force: boolean): Promise<Snapshot> {
    const { deps, maxAgeMs } = this.#options;
    const startedAt = deps.now();
    this.#lastAttemptAt = startedAt;

    const shared = await this.#readCacheFile();
    if (shared && (!this.#cached || shared.fetchedAt > this.#cached.fetchedAt)) this.#cached = shared;

    const [credentials, account] = await Promise.all([deps.readCredentials(), deps.readAccount()]);
    const meta = {
      plan: credentials.ok ? planLabel(credentials.value.subscriptionType, credentials.value.rateLimitTier) : null,
      tokenExpiresAt: credentials.ok ? credentials.value.expiresAt : null,
      account,
      credentialsSource: credentials.ok ? credentials.value.source : null,
    };

    const age = this.#cached ? startedAt - this.#cached.fetchedAt : Number.POSITIVE_INFINITY;
    if (!force && age >= 0 && age < maxAgeMs) {
      return this.#settle({ ...meta, ...this.#cachedFields(), error: null });
    }
    // Another process may be the one that got the 429.
    const waitMs = Math.max(this.#backoffUntil, (await this.#readBackoffFile()) ?? 0) - startedAt;
    if (waitMs > 0 && waitMs <= MAX_BACKOFF_MS) {
      return this.#settle({ ...meta, ...this.#cachedFields(), error: rateLimitedError(waitMs) });
    }
    if (!credentials.ok) return this.#settle({ ...meta, ...this.#cachedFields(), error: credentials.error });

    const expiresAt = credentials.value.expiresAt;
    if (expiresAt && expiresAt.getTime() - EXPIRY_SKEW_MS <= startedAt) {
      return this.#settle({
        ...meta,
        ...this.#cachedFields(),
        error: usageError('token_expired', 'O login do Claude Code expirou.', HINTS.renew),
      });
    }

    const result = await deps.fetchUsage(credentials.value.accessToken);
    if (!result.ok) {
      if (result.error.code === 'rate_limited') {
        this.#backoffUntil = deps.now() + Math.min(result.error.retryAfterMs ?? DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS);
        await this.#writeShared(this.#backoffFile(), { version: 1, until: this.#backoffUntil });
      }
      return this.#settle({ ...meta, ...this.#cachedFields(), error: result.error });
    }

    this.#cached = { payload: result.value, fetchedAt: deps.now() };
    await this.#writeShared(this.#options.cacheFile, { version: 1, ...this.#cached });
    return this.#settle({ ...meta, ...this.#cachedFields(), error: null });
  }

  #cachedFields(): Pick<Snapshot, 'payload' | 'fetchedAt'> {
    return this.#cached
      ? { payload: this.#cached.payload, fetchedAt: new Date(this.#cached.fetchedAt) }
      : { payload: null, fetchedAt: null };
  }

  #settle(snapshot: Snapshot): Snapshot {
    this.#last = snapshot;
    return snapshot;
  }

  #backoffFile(): string | null {
    const file = this.#options.cacheFile;
    return file ? join(dirname(file), 'backoff.json') : null;
  }

  async #readCacheFile(): Promise<CachedPayload | null> {
    const parsed = CacheFileSchema.safeParse(await readJson(this.#options.cacheFile));
    return parsed.success ? { payload: parsed.data.payload, fetchedAt: parsed.data.fetchedAt } : null;
  }

  async #readBackoffFile(): Promise<number | null> {
    const parsed = BackoffFileSchema.safeParse(await readJson(this.#backoffFile()));
    return parsed.success ? parsed.data.until : null;
  }

  /** Best effort, atomic, owner-only. Holds usage numbers and timestamps only, never credentials. */
  async #writeShared(file: string | null, value: unknown): Promise<void> {
    if (!file) return;
    const temp = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
      await rename(temp, file);
    } catch {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }
}

async function readJson(file: string | null): Promise<unknown> {
  if (!file) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

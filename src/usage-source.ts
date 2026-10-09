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
  /** Set with a 429: no process calls the API before this (`backoff.json`). */
  readonly retryAt: Date | null;
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
  /** `null` disables persistence (fixtures, tests). A 429 hold goes next to it, in `backoff.json`. */
  readonly cacheFile: string | null;
  readonly deps: UsageSourceDeps;
}

/** A forced refresh still waits this long after the previous attempt. */
export const FORCE_FLOOR_MS = 5_000;
/** A read younger than this is reused even when forced, and by one-shot modes (Claude Code shares reads for 60s). */
export const SHARED_READ_MS = 60_000;
/** Treat the token as expired slightly early: the request takes time. */
const EXPIRY_SKEW_MS = 30_000;
/** Hold after a 429 that brings no positive `Retry-After` (Claude Code's own); doubles per 429 in a row. */
export const BASE_HOLD_MS = 300_000;
/** Doubling stops here: 5, 10, 20, 30, 30… min. */
const MAX_STREAK_HOLD_MS = 1_800_000;
/** Longest hold, even when `Retry-After` asks for more. */
const MAX_HOLD_MS = 3_600_000;
/** A hold up to this much past MAX_HOLD_MS still counts (the clock stepped back since); further out is junk. */
const CLOCK_STEP_SLACK_MS = 300_000;
/** A 429 this long after the previous hold ended starts a new streak. */
const STREAK_MEMORY_MS = 3_600_000;

const CacheFileSchema = z.object({
  version: z.literal(1),
  fetchedAt: z.number(),
  payload: UsagePayloadSchema,
});

/**
 * Still version 1 on purpose: older builds read `until` and ignore `streak`. A file without `streak`
 * (written before it existed) or with a bad one still holds, as one 429.
 */
const BackoffFileSchema = z.object({
  version: z.literal(1),
  until: z.number(),
  streak: z.number().int().min(1).catch(1),
});

interface Hold {
  /** No API call before this (epoch ms). */
  readonly until: number;
  /** 429s in a row, with no good read in between. */
  readonly streak: number;
}

/** A positive `Retry-After` wins when longer; `0`, absent or short gets the doubling hold. */
export function holdMs(streak: number, retryAfterMs: number | null): number {
  const doubling = Math.min(BASE_HOLD_MS * 2 ** Math.min(streak - 1, 8), MAX_STREAK_HOLD_MS);
  return Math.min(Math.max(doubling, retryAfterMs ?? 0), MAX_HOLD_MS);
}

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
  #hold: Hold | null = null;
  #inflight: Promise<Snapshot> | null = null;

  constructor(options: UsageSourceOptions) {
    this.#options = options;
  }

  get(request: { readonly force?: boolean } = {}): Promise<Snapshot> {
    if (this.#inflight) return this.#inflight;
    const force = request.force === true;
    const floor = force ? FORCE_FLOOR_MS : this.#options.maxAgeMs;
    const now = this.#options.deps.now();
    // Negative elapsed = the clock went back: refresh instead of freezing until it catches up.
    const elapsed = now - this.#lastAttemptAt;
    // A hold that ended is due now, not a whole interval after the look that reported it.
    const holdEnded = (this.#last?.retryAt?.getTime() ?? Number.POSITIVE_INFINITY) <= now;
    if (this.#last && !holdEnded && elapsed >= 0 && elapsed < floor) return Promise.resolve(this.#last);
    this.#inflight = this.#refresh(force).finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #refresh(force: boolean): Promise<Snapshot> {
    const { deps, maxAgeMs } = this.#options;
    const startedAt = deps.now();
    this.#lastAttemptAt = startedAt;

    await this.#mergeCacheFile();

    const [credentials, account] = await Promise.all([deps.readCredentials(), deps.readAccount()]);
    const meta = {
      plan: credentials.ok ? planLabel(credentials.value.subscriptionType, credentials.value.rateLimitTier) : null,
      tokenExpiresAt: credentials.ok ? credentials.value.expiresAt : null,
      account,
      credentialsSource: credentials.ok ? credentials.value.source : null,
      retryAt: null,
    };

    const age = this.#cached ? startedAt - this.#cached.fetchedAt : Number.POSITIVE_INFINITY;
    // Forced or not, a read younger than SHARED_READ_MS is not repeated.
    const freshFor = force ? Math.min(maxAgeMs, SHARED_READ_MS) : maxAgeMs;
    if (age >= 0 && age < freshFor) {
      return this.#settle({ ...meta, ...this.#cachedFields(), error: null });
    }
    // Login problems first: the user can fix them now, a 429 only by waiting.
    if (!credentials.ok) return this.#settle({ ...meta, ...this.#cachedFields(), error: credentials.error });

    const expiresAt = credentials.value.expiresAt;
    if (expiresAt && expiresAt.getTime() - EXPIRY_SKEW_MS <= startedAt) {
      return this.#settle({
        ...meta,
        ...this.#cachedFields(),
        error: usageError('token_expired', 'O login do Claude Code expirou.', HINTS.renew),
      });
    }

    // Another process may be the one that got the 429.
    const hold = await this.#currentHold(startedAt);
    if (hold && hold.until > startedAt) {
      return this.#settle({ ...meta, ...this.#cachedFields(), error: rateLimitedError(), retryAt: new Date(hold.until) });
    }

    const result = await deps.fetchUsage(credentials.value.accessToken);
    if (!result.ok) {
      if (result.error.code !== 'rate_limited') return this.#settle({ ...meta, ...this.#cachedFields(), error: result.error });
      const at = deps.now();
      // A good read another process landed while ours was on the wire also ends the streak.
      await this.#mergeCacheFile();
      const streak = hold && this.#streakGoesOn(hold, at) ? hold.streak + 1 : 1;
      this.#hold = { until: at + holdMs(streak, result.error.retryAfterMs), streak };
      await this.#writeShared(this.#backoffFile(), { version: 1, ...this.#hold });
      return this.#settle({ ...meta, ...this.#cachedFields(), error: result.error, retryAt: new Date(this.#hold.until) });
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

  /** Same streak while no read succeeded since the previous hold, and it ended under STREAK_MEMORY_MS ago. */
  #streakGoesOn(previous: Hold, at: number): boolean {
    const lastGood = this.#cached?.fetchedAt ?? Number.NEGATIVE_INFINITY;
    return lastGood < previous.until && at - previous.until < STREAK_MEMORY_MS;
  }

  /** The latest hold any process recorded, skipping junk (further out than any hold can be). */
  async #currentHold(now: number): Promise<Hold | null> {
    let latest: Hold | null = null;
    for (const hold of [this.#hold, await this.#readBackoffFile()]) {
      if (hold && hold.until - now <= MAX_HOLD_MS + CLOCK_STEP_SLACK_MS && (!latest || hold.until > latest.until)) latest = hold;
    }
    return latest;
  }

  #backoffFile(): string | null {
    const file = this.#options.cacheFile;
    return file ? join(dirname(file), 'backoff.json') : null;
  }

  /** Takes the shared `last.json` when it is newer than what this process holds. */
  async #mergeCacheFile(): Promise<void> {
    const shared = await this.#readCacheFile();
    if (shared && (!this.#cached || shared.fetchedAt > this.#cached.fetchedAt)) this.#cached = shared;
  }

  async #readCacheFile(): Promise<CachedPayload | null> {
    const parsed = CacheFileSchema.safeParse(await readJson(this.#options.cacheFile));
    return parsed.success ? { payload: parsed.data.payload, fetchedAt: parsed.data.fetchedAt } : null;
  }

  async #readBackoffFile(): Promise<Hold | null> {
    const parsed = BackoffFileSchema.safeParse(await readJson(this.#backoffFile()));
    return parsed.success ? { until: parsed.data.until, streak: parsed.data.streak } : null;
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

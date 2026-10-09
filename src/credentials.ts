import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { platform, userInfo } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Env } from './env.js';
import { HINTS, usageError, type UsageError } from './errors.js';
import { claudeConfigDir } from './paths.js';
import { err, ok, type Result } from './result.js';

/** Keychain item Claude Code writes on macOS for the default config dir. */
export const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_TIMEOUT_MS = 5_000;
/** `security` exit code for errSecItemNotFound. */
const SECURITY_ITEM_NOT_FOUND = 44;

export type CredentialsSource = 'keychain' | 'file' | 'env' | 'fixture';

export interface Credentials {
  readonly accessToken: string;
  readonly expiresAt: Date | null;
  readonly subscriptionType: string | null;
  readonly rateLimitTier: string | null;
  readonly source: CredentialsSource;
}

const OauthSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.number().nullish(),
  subscriptionType: z.string().nullish(),
  rateLimitTier: z.string().nullish(),
});

const StoredCredentialsSchema = z.object({ claudeAiOauth: z.unknown().optional() });

/**
 * Parses the JSON blob Claude Code stores (Keychain or `.credentials.json`).
 * Errors never echo the content: it holds refresh tokens.
 */
export function parseStoredCredentials(raw: string, source: CredentialsSource): Result<Credentials, UsageError> {
  let json: unknown;
  try {
    json = JSON.parse(decodeKeychainPayload(raw.trim()));
  } catch {
    return err(usageError('bad_credentials', 'As credenciais do Claude Code estão em formato inesperado.', HINTS.login));
  }
  const stored = StoredCredentialsSchema.safeParse(json);
  const oauth = stored.success ? OauthSchema.safeParse(stored.data.claudeAiOauth) : null;
  if (!oauth?.success) {
    return err(usageError('no_credentials', 'O Claude Code não tem login claude.ai (OAuth).', HINTS.login));
  }
  const { accessToken, expiresAt, subscriptionType, rateLimitTier } = oauth.data;
  return ok({
    accessToken,
    expiresAt: typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? new Date(expiresAt) : null,
    subscriptionType: subscriptionType ?? null,
    rateLimitTier: rateLimitTier ?? null,
    source,
  });
}

/** `security -w` prints secrets that are not clean UTF-8 as hex; accept both forms. */
function decodeKeychainPayload(text: string): string {
  if (text.startsWith('{') || !/^(?:[0-9a-f]{2})+$/i.test(text)) return text;
  return Buffer.from(text, 'hex').toString('utf8');
}

interface ExecOutcome {
  readonly code: number | string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function runSecurity(args: readonly string[]): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    execFile(
      'security',
      [...args],
      { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr, timedOut: false });
          return;
        }
        resolve({ code: error.code ?? null, stdout, stderr, timedOut: error.killed === true });
      },
    );
  });
}

type KeychainRead =
  | { readonly kind: 'found'; readonly raw: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly error: UsageError };

function currentUser(): string | null {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

async function readKeychain(service: string): Promise<KeychainRead> {
  const account = currentUser();
  const selectors = account ? [['-a', account, '-s', service], ['-s', service]] : [['-s', service]];
  for (const selector of selectors) {
    const outcome = await runSecurity(['find-generic-password', ...selector, '-w']);
    if (outcome.code === 0) return { kind: 'found', raw: outcome.stdout };
    if (outcome.timedOut) {
      return {
        kind: 'error',
        error: usageError(
          'keychain_error',
          'O Keychain não respondeu.',
          'Desbloqueie o Keychain (ou aprove o acesso) e tente de novo.',
        ),
      };
    }
    if (outcome.code !== SECURITY_ITEM_NOT_FOUND) {
      const detail = outcome.stderr.trim().split('\n')[0] ?? '';
      return {
        kind: 'error',
        error: usageError(
          'keychain_error',
          `Falha ao ler o Keychain${detail ? `: ${detail}` : ` (código ${String(outcome.code)})`}.`,
          'Desbloqueie o Keychain e tente de novo.',
        ),
      };
    }
  }
  return { kind: 'missing' };
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export interface ReadCredentialsOptions {
  readonly env: Env;
  readonly platform?: NodeJS.Platform;
}

/**
 * Read-only, same lookup order as Claude Code: Keychain (macOS), then
 * `<config dir>/.credentials.json`, then `CLAUDE_CODE_OAUTH_TOKEN`.
 * Never refreshes the token: refreshing rotates the refresh token and would
 * log Claude Code out.
 */
export async function readCredentials(options: ReadCredentialsOptions): Promise<Result<Credentials, UsageError>> {
  let keychainError: UsageError | null = null;
  if ((options.platform ?? platform()) === 'darwin') {
    const keychain = await readKeychain(KEYCHAIN_SERVICE);
    if (keychain.kind === 'found') return parseStoredCredentials(keychain.raw, 'keychain');
    if (keychain.kind === 'error') keychainError = keychain.error;
  }
  const fromFile = await readOptionalFile(join(claudeConfigDir(options.env), '.credentials.json'));
  if (fromFile !== null) return parseStoredCredentials(fromFile, 'file');
  if (keychainError) return err(keychainError);
  const envToken = options.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) {
    return ok({ accessToken: envToken, expiresAt: null, subscriptionType: null, rateLimitTier: null, source: 'env' });
  }
  return err(usageError('no_credentials', 'Nenhum login do Claude Code encontrado.', HINTS.login));
}

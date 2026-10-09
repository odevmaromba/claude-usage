import { formatDuration } from './format.js';

export type UsageErrorCode =
  | 'no_credentials'
  | 'bad_credentials'
  | 'keychain_error'
  | 'token_expired'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'upstream_error'
  | 'network_error'
  | 'timeout'
  | 'bad_response';

export interface UsageError {
  readonly code: UsageErrorCode;
  /** pt-BR, safe to show: never carries tokens or raw credential content. */
  readonly message: string;
  /** Next step for the user; text between backticks is a command. */
  readonly hint: string | null;
  readonly retryAfterMs: number | null;
}

export const HINTS = {
  renew: 'Abra o `claude` uma vez pra renovar o login.',
  login: 'Rode `claude` e faça `/login` com a conta claude.ai.',
  retry: 'Tente de novo em instantes.',
} as const;

export function usageError(
  code: UsageErrorCode,
  message: string,
  hint: string | null = null,
  retryAfterMs: number | null = null,
): UsageError {
  return { code, message, hint, retryAfterMs };
}

/** 429, from the API or from a backoff still running (in any process). */
export function rateLimitedError(waitMs: number): UsageError {
  return usageError('rate_limited', 'Consultas demais em pouco tempo (429).', `Próxima consulta liberada em ${formatDuration(waitMs)}.`, waitMs);
}

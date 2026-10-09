import { readFileSync } from 'node:fs';
import { UsagePayloadSchema, type UsagePayload } from '../src/usage-api.js';

export const TZ = 'America/Sao_Paulo';
/** qua 07/10/2026 12:20:47 in São Paulo — when the real fixture was captured. */
export const CAPTURED_AT = new Date('2026-10-07T15:20:47Z');

export function loadFixture(name: string): UsagePayload {
  const raw: unknown = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
  return UsagePayloadSchema.parse(raw);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

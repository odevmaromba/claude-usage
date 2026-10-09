import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { stripControl } from './text.js';

export interface AccountInfo {
  readonly email: string | null;
  readonly displayName: string | null;
}

const GlobalConfigSchema = z.object({
  oauthAccount: z
    .object({
      emailAddress: z.string().nullish(),
      displayName: z.string().nullish(),
    })
    .nullish(),
});

/** Account label from Claude Code's global config. Best effort: any failure means "unknown". */
export async function readAccount(file: string): Promise<AccountInfo | null> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
  const parsed = GlobalConfigSchema.safeParse(json);
  const account = parsed.success ? parsed.data.oauthAccount : null;
  if (!account) return null;
  const clean = (value: string | null | undefined): string | null => (value ? stripControl(value).trim() || null : null);
  return { email: clean(account.emailAddress), displayName: clean(account.displayName) };
}

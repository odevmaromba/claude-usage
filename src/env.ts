import { z } from 'zod';

const trimmed = z
  .string()
  .optional()
  .transform((value) => {
    const clean = value?.trim();
    return clean ? clean : undefined;
  });

const EnvSchema = z.object({
  CLAUDE_CONFIG_DIR: trimmed,
  CLAUDE_CODE_OAUTH_TOKEN: trimmed,
  CLAUDE_USAGE_FIXTURE: trimmed,
  XDG_CACHE_HOME: trimmed,
  NO_COLOR: z.string().optional(),
  FORCE_COLOR: z.string().optional(),
  TERM: trimmed,
  COLORTERM: trimmed,
});

export type Env = z.infer<typeof EnvSchema>;

/** Single place that reads `process.env`; everything else receives an `Env`. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}

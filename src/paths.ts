import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Env } from './env.js';

/** Claude Code config dir: `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
export function claudeConfigDir(env: Env): string {
  return env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

/** Claude Code global config (holds `oauthAccount`): moves with `$CLAUDE_CONFIG_DIR`. */
export function claudeGlobalConfigFile(env: Env): string {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json');
}

export function cacheDir(env: Env): string {
  return join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'claude-usage');
}

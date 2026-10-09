import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseStoredCredentials, readCredentials } from '../src/credentials.js';
import { loadEnv } from '../src/env.js';

const SECRET = 'sk-ant-ort01-SECRET-do-not-leak';
const BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-ACCESS',
    refreshToken: SECRET,
    expiresAt: 1791413777353,
    refreshTokenExpiresAt: 1800000000000,
    scopes: ['user:profile', 'user:inference'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
  },
  mcpOAuth: { vercel: { accessToken: 'x' } },
});

describe('parseStoredCredentials', () => {
  it('parses the JSON Claude Code stores', () => {
    const result = parseStoredCredentials(`${BLOB}\n`, 'keychain');
    expect(result).toEqual({
      ok: true,
      value: {
        accessToken: 'sk-ant-oat01-ACCESS',
        expiresAt: new Date(1791413777353),
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
        source: 'keychain',
      },
    });
  });

  it('accepts hex output from `security -w`', () => {
    const result = parseStoredCredentials(Buffer.from(BLOB, 'utf8').toString('hex'), 'keychain');
    expect(result.ok && result.value.accessToken).toBe('sk-ant-oat01-ACCESS');
  });

  it('never echoes credential content in errors', () => {
    const result = parseStoredCredentials(`{"refreshToken":"${SECRET}"`, 'file');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    if (!result.ok) expect(result.error.code).toBe('bad_credentials');
  });

  it('reports a login without claude.ai OAuth', () => {
    const result = parseStoredCredentials('{"mcpOAuth":{}}', 'file');
    expect(!result.ok && result.error.code).toBe('no_credentials');
  });

  it('treats a missing or bogus expiresAt as unknown', () => {
    const result = parseStoredCredentials('{"claudeAiOauth":{"accessToken":"a","expiresAt":null}}', 'file');
    expect(result.ok && result.value.expiresAt).toBeNull();
  });
});

describe('readCredentials (non-macOS lookup)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-usage-creds-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads <CLAUDE_CONFIG_DIR>/.credentials.json', async () => {
    await writeFile(join(dir, '.credentials.json'), BLOB);
    const result = await readCredentials({ env: loadEnv({ CLAUDE_CONFIG_DIR: dir }), platform: 'linux' });
    expect(result.ok && result.value.source).toBe('file');
  });

  it('falls back to CLAUDE_CODE_OAUTH_TOKEN', async () => {
    const result = await readCredentials({
      env: loadEnv({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: ' sk-ant-oat01-ENV ' }),
      platform: 'linux',
    });
    expect(result).toEqual({
      ok: true,
      value: { accessToken: 'sk-ant-oat01-ENV', expiresAt: null, subscriptionType: null, rateLimitTier: null, source: 'env' },
    });
  });

  it('reports no_credentials when nothing is there', async () => {
    const result = await readCredentials({ env: loadEnv({ CLAUDE_CONFIG_DIR: dir }), platform: 'linux' });
    expect(!result.ok && result.error.code).toBe('no_credentials');
  });
});

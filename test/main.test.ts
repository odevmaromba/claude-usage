import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';
import { stripAnsi } from './helpers.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/usage-2026-10-07.json', import.meta.url));
const CONTEXT = { entry: '/dev/null' };

let stdout = '';
let stderr = '';

beforeEach(() => {
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  vi.stubEnv('CLAUDE_USAGE_FIXTURE', FIXTURE);
  vi.stubEnv('NO_COLOR', '1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('main', () => {
  it('prints help and version', async () => {
    expect(await main(['--help'], CONTEXT)).toBe(0);
    expect(stdout).toContain('claude-usage --web');
    expect(stdout).toContain('--idle-exit <s>');
    stdout = '';
    expect(await main(['-v'], CONTEXT)).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each([
    [['--watch', '--web'], 'use um modo só'],
    [['--json', '--serve'], 'use um modo só'],
    [['--interval', '10'], '--interval aceita de 30 a 3600'],
    [['-i', 'abc'], '--interval aceita de 30 a 3600'],
    [['--port', '80'], '--port aceita de 1024 a 65535'],
    [['--idle-exit', '5'], '--idle-exit aceita de 30 a 86400'],
    [['--bogus'], 'Veja claude-usage --help'],
    [['extra'], 'Veja claude-usage --help'],
  ])('rejects %j with exit 2', async (argv, message) => {
    expect(await main(argv, CONTEXT)).toBe(2);
    expect(stderr).toContain(message);
  });

  it('renders the screen from a fixture', async () => {
    expect(await main([], CONTEXT)).toBe(0);
    const screen = stripAnsi(stdout);
    expect(screen).toContain('CLAUDE · USO DO PLANO');
    expect(screen).toContain('Sessão atual · janela de 5h');
    expect(screen).toContain('Semana · só Fable');
    expect(screen).toContain('! Dados de fixture (CLAUDE_USAGE_FIXTURE), não da sua conta.');
    expect(stdout).not.toContain('\u001b[');
  });

  it('lets --color win over NO_COLOR and a pipe', async () => {
    expect(await main(['--color'], CONTEXT)).toBe(0);
    expect(stdout).toContain('\u001b[');
  });

  it('prints the raw payload with --json', async () => {
    expect(await main(['--json'], CONTEXT)).toBe(0);
    const payload: unknown = JSON.parse(stdout);
    expect(payload).toHaveProperty('limits.0', expect.objectContaining({ kind: 'session', percent: 14 }));
  });

  it('exits 1 when the fixture cannot be read', async () => {
    vi.stubEnv('CLAUDE_USAGE_FIXTURE', '/nonexistent/usage.json');
    expect(await main(['--json'], CONTEXT)).toBe(1);
    expect(stderr).toContain('fixture');
  });

  it('refuses -w without a terminal', async () => {
    expect(await main(['-w'], CONTEXT)).toBe(2);
    expect(stderr).toContain('terminal interativo');
  });

  it('refuses -w on TERM=dumb', async () => {
    vi.stubEnv('TERM', 'dumb');
    expect(await main(['-w'], CONTEXT)).toBe(2);
    expect(stderr).toContain('TERM=dumb');
  });
});

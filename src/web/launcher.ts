import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { formatDuration } from '../format.js';
import { stripControl } from '../text.js';
import { APP_ID, LOOPBACK } from './server.js';

/** Stable across versions: enough to tell a claude-usage server from another program. */
const IdentitySchema = z.object({
  app: z.literal(APP_ID),
  version: z.string(),
  pid: z.number(),
});

const HealthSchema = IdentitySchema.extend({
  fixture: z.boolean(),
  intervalSec: z.number(),
  idleExitSec: z.number().nullable(),
});

export type Health = z.infer<typeof HealthSchema>;

export type Probe =
  | { readonly kind: 'ours'; readonly health: Health }
  /** A claude-usage whose health lacks what this CLI needs to reuse it (another build). */
  | { readonly kind: 'stale'; readonly pid: number }
  | { readonly kind: 'other' }
  | { readonly kind: 'none' };

function causeCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : null;
  }
  return null;
}

/** Who answers on the port: our server, something else, or nobody. */
export async function probe(port: number, timeoutMs = 800): Promise<Probe> {
  let response: Response;
  try {
    response = await fetch(`http://${LOOPBACK}:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return causeCode(error) === 'ECONNREFUSED' ? { kind: 'none' } : { kind: 'other' };
  }
  const body: unknown = await response.json().catch(() => null);
  const parsed = HealthSchema.safeParse(body);
  if (parsed.success) return { kind: 'ours', health: parsed.data };
  const identity = IdentitySchema.safeParse(body);
  return identity.success ? { kind: 'stale', pid: identity.data.pid } : { kind: 'other' };
}

/** Health of the claude-usage server that answers first: ours, or another launch's that won the port. */
async function waitForServer(port: number, timeoutMs: number): Promise<Health | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await probe(port, 400);
    if (found.kind === 'ours') return found.health;
    await sleep(120);
  }
  return null;
}

const CHROME_APPS = ['/Applications/Google Chrome.app', join(homedir(), 'Applications', 'Google Chrome.app')];

/** Chrome app window (no tabs/URL bar) when available; else the default browser. */
export function openWindow(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === 'darwin') {
    command = 'open';
    args = CHROME_APPS.some((app) => existsSync(app))
      ? ['-na', 'Google Chrome', '--args', `--app=${url}`, '--window-size=470,760']
      : [url];
  } else if (process.platform === 'linux') {
    command = 'xdg-open';
    args = [url];
  } else {
    return;
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}

export interface LaunchOptions {
  readonly port: number;
  readonly intervalSec: number;
  readonly idleExitSec: number;
  /** This CLI runs on `CLAUDE_USAGE_FIXTURE`: only a fixture server may be reused, and vice versa. */
  readonly fixture: boolean;
  readonly open: boolean;
  /** Absolute path of this CLI's entry file. */
  readonly cliPath: string;
  readonly version: string;
  readonly logFile: string;
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
}

function readyLine(url: string, opened: boolean, idleExitSec: number | null): string {
  const lifetime =
    idleExitSec === null
      ? 'o servidor fica de pé até ser encerrado'
      : opened
        ? `o servidor fecha sozinho ${formatDuration(idleExitSec * 1000)} depois que a janela fechar`
        : `o servidor fecha sozinho após ${formatDuration(idleExitSec * 1000)} sem acessos`;
  return `${opened ? 'Tela' : 'Servidor'} em ${url} — ${lifetime}.`;
}

/** Refuses a server with the other kind of data (returns false); warns on version/interval drift. */
function acceptServer(health: Health, options: LaunchOptions): boolean {
  if (health.fixture !== options.fixture) {
    const data = health.fixture ? 'dados de fixture' : 'dados da conta';
    options.printError(`a porta ${options.port} tem um claude-usage com ${data} (pid ${health.pid}). Encerre-o ou use --port <n>.`);
    return false;
  }
  if (health.version !== options.version) {
    options.printError(`aviso: o servidor rodando é v${stripControl(health.version)} (CLI v${options.version}).`);
  }
  if (health.intervalSec !== options.intervalSec) {
    options.printError(`aviso: o servidor rodando atualiza a cada ${health.intervalSec}s, não ${options.intervalSec}s.`);
  }
  return true;
}

/**
 * Reuses a matching server or starts one detached (it exits by itself after
 * `idleExitSec` without requests), then opens the window. Returns an exit code.
 */
export async function launchWeb(options: LaunchOptions): Promise<number> {
  const url = `http://${LOOPBACK}:${options.port}/`;
  const current = await probe(options.port);

  if (current.kind === 'stale') {
    options.printError(`a porta ${options.port} tem um claude-usage de outro build (pid ${current.pid}). Encerre-o (kill ${current.pid}) ou use --port <n>.`);
    return 1;
  }
  if (current.kind === 'other') {
    options.printError(`a porta ${options.port} está ocupada por outro programa. Use --port <n>.`);
    return 1;
  }
  let health: Health | null = current.kind === 'ours' ? current.health : null;
  if (health === null) {
    mkdirSync(dirname(options.logFile), { recursive: true, mode: 0o700 });
    // Append: the previous server's last lines are often the ones that explain a failure.
    const logFd = openSync(options.logFile, 'a', 0o600);
    try {
      const child = spawn(
        process.execPath,
        [
          options.cliPath,
          '--serve',
          '--port',
          String(options.port),
          '--interval',
          String(options.intervalSec),
          '--idle-exit',
          String(options.idleExitSec),
        ],
        { detached: true, stdio: ['ignore', logFd, logFd] },
      );
      child.on('error', () => undefined);
      child.unref();
    } finally {
      closeSync(logFd);
    }
    // Another launch may win the port first: its server gets the same checks as a reused one.
    health = await waitForServer(options.port, 5_000);
    if (health === null) {
      options.printError(`o servidor não subiu. Log: ${options.logFile}`);
      return 1;
    }
  }
  if (!acceptServer(health, options)) return 1;

  if (options.open) openWindow(url);
  options.print(readyLine(url, options.open, health.idleExitSec));
  return 0;
}

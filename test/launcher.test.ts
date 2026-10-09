import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERSION } from '../src/version.js';
import { launchWeb, type Health, type LaunchOptions } from '../src/web/launcher.js';
import { LOOPBACK } from '../src/web/server.js';

// Our `--serve` child loses the port to another launch: spawning it binds that launch's server instead.
const race = vi.hoisted(() => {
  const state: { winner: (() => void) | null } = { winner: null };
  return state;
});
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    race.winner?.();
    return { on: () => undefined, unref: () => undefined };
  }),
}));

let other: Server | null = null;
let port = 0;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, LOOPBACK, resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === 'string') throw new Error('no TCP port');
  return address.port;
}

function winsThePort(health: object): void {
  race.winner = () => {
    other = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
    });
    other.listen(port, LOOPBACK);
  };
}

const print = vi.fn();
const printError = vi.fn();
const options = (overrides: Partial<LaunchOptions> = {}): LaunchOptions => ({
  port,
  intervalSec: 60,
  idleExitSec: 300,
  fixture: false,
  open: false,
  cliPath: '/dev/null',
  version: VERSION,
  logFile: '/dev/null',
  print,
  printError,
  ...overrides,
});
const WINNER: Health = { app: 'claude-usage', version: VERSION, pid: 4242, fixture: false, intervalSec: 60, idleExitSec: 300 };

beforeEach(async () => {
  port = await freePort();
  print.mockReset();
  printError.mockReset();
});

afterEach(async () => {
  race.winner = null;
  if (other) await new Promise((resolve) => other?.close(resolve));
  other = null;
});

describe('launchWeb when another launch wins the port', () => {
  it('refuses a fixture server that won the race against an account run', async () => {
    winsThePort({ ...WINNER, fixture: true });
    expect(await launchWeb(options())).toBe(1);
    expect(printError).toHaveBeenCalledWith(expect.stringContaining('claude-usage com dados de fixture (pid 4242)'));
    expect(print).not.toHaveBeenCalled();
  });

  it('warns about the winner interval and describes the winner idle exit', async () => {
    winsThePort({ ...WINNER, intervalSec: 120, idleExitSec: 3600 });
    expect(await launchWeb(options())).toBe(0);
    expect(printError).toHaveBeenCalledWith('aviso: o servidor rodando atualiza a cada 120s, não 60s.');
    expect(print).toHaveBeenCalledWith(`Servidor em http://${LOOPBACK}:${port}/ — o servidor fecha sozinho após 1h sem acessos.`);
  });

  it('names a claude-usage from another build that won the race, without waiting out the 5s', async () => {
    winsThePort({ app: 'claude-usage', version: '0.0.9', pid: 4242 });
    const started = Date.now();
    expect(await launchWeb(options())).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(printError).toHaveBeenCalledWith(expect.stringContaining('outro build (pid 4242)'));
    expect(print).not.toHaveBeenCalled();
  });

  it('stays quiet when the server that answers matches this launch', async () => {
    winsThePort(WINNER);
    expect(await launchWeb(options())).toBe(0);
    expect(printError).not.toHaveBeenCalled();
    expect(print).toHaveBeenCalledWith(`Servidor em http://${LOOPBACK}:${port}/ — o servidor fecha sozinho após 5 min sem acessos.`);
  });
});

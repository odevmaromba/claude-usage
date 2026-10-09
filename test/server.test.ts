import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HINTS, rateLimitedError, usageError, type UsageErrorCode } from '../src/errors.js';
import type { Snapshot, SnapshotProvider } from '../src/usage-source.js';
import { VERSION } from '../src/version.js';
import { launchWeb, probe, type LaunchOptions } from '../src/web/launcher.js';
import {
  createUsageServer,
  isAllowedHost,
  LOOPBACK,
  statusForError,
  watchIdle,
  type ServerInfo,
  type UsageServer,
} from '../src/web/server.js';
import { CAPTURED_AT, loadFixture } from './helpers.js';

const GOOD: Snapshot = {
  payload: loadFixture('usage-2026-10-07.json'),
  fetchedAt: CAPTURED_AT,
  error: null,
  plan: 'Max 20x',
  tokenExpiresAt: null,
  account: null,
  credentialsSource: 'keychain',
  retryAt: null,
};

const INFO: ServerInfo = { fixture: false, intervalSec: 60, idleExitSec: 300 };

class FakeProvider implements SnapshotProvider {
  next: Snapshot | Error = GOOD;
  requests: Array<{ readonly force?: boolean }> = [];
  async get(request: { readonly force?: boolean } = {}): Promise<Snapshot> {
    this.requests.push(request);
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server is not listening on TCP');
  return address.port;
}

let app: UsageServer;
let provider: FakeProvider;
let port: number;

function call(path: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: LOOPBACK,
        port,
        path,
        method: options.method ?? 'GET',
        headers: { host: `${LOOPBACK}:${port}`, ...options.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  provider = new FakeProvider();
  app = createUsageServer({ source: provider, info: INFO, now: () => CAPTURED_AT });
  await new Promise<void>((resolve) => app.server.listen(0, LOOPBACK, resolve));
  port = portOf(app.server);
});

afterEach(async () => {
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
});

describe('usage server', () => {
  it('serves the page with a per-response CSP nonce', async () => {
    const first = await call('/');
    const second = await call('/');
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('text/html; charset=utf-8');
    const csp = String(first.headers['content-security-policy']);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain(`style-src 'nonce-${nonce}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(first.body).toContain(`<script nonce="${nonce}">`);
    expect(first.body).toContain(`<style nonce="${nonce}">`);
    expect(second.headers['content-security-policy']).not.toBe(csp);
  });

  it('sets hardening headers on every response', async () => {
    for (const path of ['/', '/api/usage', '/api/health', '/nope']) {
      const reply = await call(path);
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.headers['x-content-type-options']).toBe('nosniff');
      expect(reply.headers['x-frame-options']).toBe('DENY');
      expect(reply.headers['referrer-policy']).toBe('no-referrer');
    }
  });

  it('refuses foreign Host headers (DNS rebinding)', async () => {
    const reply = await call('/api/usage', { headers: { host: `evil.example:${port}` } });
    expect(reply.status).toBe(421);
    expect(provider.requests).toHaveLength(0);
    expect((await call('/', { headers: { host: `localhost:${port}` } })).status).toBe(200);
    expect((await call('/', { headers: { host: `${LOOPBACK}:${port + 1}` } })).status).toBe(421);
  });

  it('refuses cross-site API reads', async () => {
    const reply = await call('/api/usage', { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body)).toEqual({ error: { code: 'cross_site', message: 'Origem não permitida.' } });
    expect((await call('/api/usage', { headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403);
    expect((await call('/api/usage', { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    expect(provider.requests).toHaveLength(1);
  });

  it('only accepts GET and HEAD', async () => {
    const post = await call('/api/usage?force=1', { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
    expect(provider.requests).toHaveLength(0);
    const head = await call('/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('returns the display and passes force through', async () => {
    const reply = await call('/api/usage?force=1');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
    const body: unknown = JSON.parse(reply.body);
    expect(body).toMatchObject({ display: { hasData: true, limits: [{}, {}, {}] } });
    expect(provider.requests).toEqual([{ force: true }]);
    await call('/api/usage');
    expect(provider.requests[1]).toEqual({ force: false });
  });

  it('keeps 200 when stale data is shown next to an error', async () => {
    provider.next = { ...GOOD, error: usageError('token_expired', 'O login do Claude Code expirou.', HINTS.renew) };
    const reply = await call('/api/usage');
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).display.notice.level).toBe('warning');
  });

  it('uses a semantic status when there is nothing to show', async () => {
    provider.next = {
      ...GOOD,
      payload: null,
      fetchedAt: null,
      error: usageError('no_credentials', 'Nenhum login do Claude Code encontrado.', HINTS.login),
    };
    const reply = await call('/api/usage');
    expect(reply.status).toBe(401);
    const body = JSON.parse(reply.body);
    expect(body.error).toEqual({ code: 'no_credentials', message: 'Nenhum login do Claude Code encontrado.', hint: HINTS.login });
    expect(body.display.notice.level).toBe('error');
  });

  it('says when the next call goes out in a 429 with nothing to show', async () => {
    provider.next = { ...GOOD, payload: null, fetchedAt: null, error: rateLimitedError(), retryAt: new Date(CAPTURED_AT.getTime() + 5 * 60_000) };
    const reply = await call('/api/usage');
    expect(reply.status).toBe(429);
    const body = JSON.parse(reply.body);
    expect(body.error.hint).toMatch(/^Próxima consulta liberada às \d\d:\d\d\.$/);
    expect(body.display.notice.hint).toBe(body.error.hint);
  });

  it('answers health checks and 404s', async () => {
    const health = await call('/api/health');
    expect(JSON.parse(health.body)).toEqual({ app: 'claude-usage', version: VERSION, pid: process.pid, ...INFO });
    const missing = await call('/favicon.ico');
    expect(missing.status).toBe(404);
  });

  it('turns a provider crash into a generic 500', async () => {
    provider.next = new Error('boom with secret detail');
    const reply = await call('/api/usage');
    expect(reply.status).toBe(500);
    expect(reply.body).not.toContain('secret');
  });

  it('counts requests for the idle exit, refused ones included', async () => {
    const before = app.requests();
    await call('/api/health');
    await call('/api/usage', { headers: { host: 'evil.example' } });
    expect(app.requests()).toBe(before + 2);
  });
});

describe('watchIdle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once after enough idle ticks; a request starts the count over', () => {
    vi.useFakeTimers();
    let count = 0;
    const onIdle = vi.fn();
    watchIdle(() => count, 60_000, onIdle);
    vi.advanceTimersByTime(45_000);
    count += 1;
    vi.advanceTimersByTime(15_000 + 45_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(15_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('never counts a clock jump (the Mac slept) as idle time', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    watchIdle(() => 0, 300_000, onIdle);
    vi.setSystemTime(Date.now() + 3_600_000);
    vi.advanceTimersByTime(15_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('stops when told to', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const stop = watchIdle(() => 0, 30_000, onIdle);
    stop();
    vi.advanceTimersByTime(120_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe('probe', () => {
  it('recognizes our server, nobody, and strangers', async () => {
    expect(await probe(port)).toEqual({ kind: 'ours', health: { app: 'claude-usage', version: VERSION, pid: process.pid, ...INFO } });

    const free = port;
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    expect(await probe(free)).toEqual({ kind: 'none' });

    const stranger = createServer((_req, res) => res.end('hello'));
    await new Promise<void>((resolve) => stranger.listen(0, LOOPBACK, resolve));
    expect(await probe(portOf(stranger))).toEqual({ kind: 'other' });
    stranger.close();

    app = createUsageServer({ source: provider, info: INFO });
    await new Promise<void>((resolve) => app.server.listen(0, LOOPBACK, resolve));
    port = portOf(app.server);
  });
});

describe('launchWeb with a server already on the port', () => {
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

  beforeEach(() => {
    print.mockReset();
    printError.mockReset();
  });

  it('reuses a matching server and describes its own idle exit', async () => {
    expect(await launchWeb(options({ idleExitSec: 900 }))).toBe(0);
    expect(print).toHaveBeenCalledWith(`Servidor em http://${LOOPBACK}:${port}/ — o servidor fecha sozinho após 5 min sem acessos.`);
    expect(printError).not.toHaveBeenCalled();
  });

  it('warns on stderr when the running server polls at another interval', async () => {
    expect(await launchWeb(options({ intervalSec: 120 }))).toBe(0);
    expect(printError).toHaveBeenCalledWith('aviso: o servidor rodando atualiza a cada 60s, não 120s.');
  });

  it('refuses to show account data to a fixture run, and the reverse', async () => {
    expect(await launchWeb(options({ fixture: true }))).toBe(1);
    expect(printError).toHaveBeenCalledWith(expect.stringContaining(`claude-usage com dados da conta (pid ${process.pid})`));
    expect(print).not.toHaveBeenCalled();
  });

  it('says when the server never exits by itself', async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    app = createUsageServer({ source: provider, info: { ...INFO, idleExitSec: null } });
    await new Promise<void>((resolve) => app.server.listen(0, LOOPBACK, resolve));
    port = portOf(app.server);
    expect(await launchWeb(options())).toBe(0);
    expect(print).toHaveBeenCalledWith(`Servidor em http://${LOOPBACK}:${port}/ — o servidor fica de pé até ser encerrado.`);
  });

  it('sends a busy port to stderr', async () => {
    const stranger = createServer((_req, res) => res.end('hello'));
    await new Promise<void>((resolve) => stranger.listen(0, LOOPBACK, resolve));
    expect(await launchWeb(options({ port: portOf(stranger) }))).toBe(1);
    expect(printError).toHaveBeenCalledWith(expect.stringContaining('ocupada por outro programa'));
    stranger.close();
  });
});

describe('helpers', () => {
  it('maps error codes to HTTP statuses', () => {
    const table: ReadonlyArray<readonly [UsageErrorCode, number]> = [
      ['no_credentials', 401],
      ['bad_credentials', 401],
      ['token_expired', 401],
      ['unauthorized', 401],
      ['forbidden', 403],
      ['rate_limited', 429],
      ['timeout', 504],
      ['keychain_error', 500],
      ['upstream_error', 502],
      ['network_error', 502],
      ['bad_response', 502],
    ];
    for (const [code, status] of table) expect(statusForError(code)).toBe(status);
  });

  it('allows only loopback hosts on our port', () => {
    expect(isAllowedHost('127.0.0.1:7177', 7177)).toBe(true);
    expect(isAllowedHost('LOCALHOST:7177', 7177)).toBe(true);
    expect(isAllowedHost('127.0.0.1', 7177)).toBe(false);
    expect(isAllowedHost('127.0.0.1.nip.io:7177', 7177)).toBe(false);
    expect(isAllowedHost(undefined, 7177)).toBe(false);
    expect(isAllowedHost('127.0.0.1:7177', null)).toBe(false);
  });
});

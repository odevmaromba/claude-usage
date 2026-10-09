import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { toDisplay } from '../display.js';
import type { UsageErrorCode } from '../errors.js';
import type { Logger } from '../log.js';
import type { SnapshotProvider } from '../usage-source.js';
import { VERSION } from '../version.js';
import { renderPage } from './page.js';

export const APP_ID = 'claude-usage';
export const LOOPBACK = '127.0.0.1';

const BASE_HEADERS: OutgoingHttpHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

const AUTH_CODES: ReadonlySet<UsageErrorCode> = new Set(['no_credentials', 'bad_credentials', 'token_expired', 'unauthorized']);

export function statusForError(code: UsageErrorCode): number {
  if (AUTH_CODES.has(code)) return 401;
  if (code === 'forbidden') return 403;
  if (code === 'rate_limited') return 429;
  if (code === 'timeout') return 504;
  if (code === 'keychain_error') return 500;
  return 502;
}

/** Only our own origin: blocks DNS rebinding (a foreign Host header) before anything else runs. */
export function isAllowedHost(host: string | undefined, port: number | null): boolean {
  if (!host || port === null) return false;
  const value = host.toLowerCase();
  return value === `${LOOPBACK}:${port}` || value === `localhost:${port}`;
}

/** Browsers send Sec-Fetch-Site; anything but our own page (or a typed URL) is refused. */
function isCrossSite(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  return typeof site === 'string' && site !== 'same-origin' && site !== 'none';
}

function listeningPort(server: Server): number | null {
  const address = server.address();
  return address !== null && typeof address === 'object' ? address.port : null;
}

function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  headers: OutgoingHttpHeaders = {},
): void {
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, value: unknown): void {
  send(req, res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function sendError(req: IncomingMessage, res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(req, res, status, { error: { code, message } });
}

/** What `/api/health` reports, so `--web` only reuses a server that matches it. */
export interface ServerInfo {
  /** Serves `CLAUDE_USAGE_FIXTURE` data instead of the account's. */
  readonly fixture: boolean;
  readonly intervalSec: number;
  /** `null`: runs until stopped. */
  readonly idleExitSec: number | null;
}

export interface UsageServerOptions {
  readonly source: SnapshotProvider;
  readonly info: ServerInfo;
  readonly now?: () => Date;
}

export interface UsageServer {
  readonly server: Server;
  /** Requests received so far. */
  requests(): number;
}

export function createUsageServer(options: UsageServerOptions): UsageServer {
  const now = options.now ?? ((): Date => new Date());
  let requests = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isAllowedHost(req.headers.host, listeningPort(server))) {
      sendError(req, res, 421, 'bad_host', 'Host não permitido.');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, 'method_not_allowed', 'Método não permitido.');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);

    if (url.pathname === '/') {
      const nonce = randomBytes(16).toString('base64');
      send(req, res, 200, renderPage(nonce), 'text/html; charset=utf-8', {
        'Content-Security-Policy': [
          "default-src 'none'",
          `script-src 'nonce-${nonce}'`,
          `style-src 'nonce-${nonce}'`,
          'img-src data:',
          "connect-src 'self'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join('; '),
      });
      return;
    }
    if (url.pathname === '/api/health') {
      sendJson(req, res, 200, { app: APP_ID, version: VERSION, pid: process.pid, ...options.info });
      return;
    }
    if (url.pathname === '/api/usage') {
      if (isCrossSite(req)) {
        sendError(req, res, 403, 'cross_site', 'Origem não permitida.');
        return;
      }
      const snapshot = await options.source.get({ force: url.searchParams.get('force') === '1' });
      const display = toDisplay(snapshot, now());
      if (!display.hasData && snapshot.error) {
        sendJson(req, res, statusForError(snapshot.error.code), {
          // The notice's hint: for a 429 it carries the next-call time, which the error alone does not.
          error: { code: snapshot.error.code, message: snapshot.error.message, hint: display.notice?.hint ?? null },
          display,
        });
        return;
      }
      sendJson(req, res, 200, { display });
      return;
    }
    sendError(req, res, 404, 'not_found', 'Não encontrado.');
  };

  const server = createServer((req, res) => {
    requests += 1;
    handle(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else sendError(req, res, 500, 'internal', 'Erro interno.');
    });
  });

  return { server, requests: () => requests };
}

const IDLE_TICK_MS = 15_000;

/**
 * Calls `onIdle` once after `idleExitMs` of awake time without new requests.
 * Counts timer ticks instead of reading a clock: timers stand still while the
 * Mac sleeps, but `performance.now()` and `Date.now()` keep running.
 */
export function watchIdle(requests: () => number, idleExitMs: number, onIdle: () => void): () => void {
  const tickMs = Math.min(IDLE_TICK_MS, idleExitMs);
  let seen = requests();
  let idleTicks = 0;
  const timer = setInterval(() => {
    const count = requests();
    if (count !== seen) {
      seen = count;
      idleTicks = 0;
      return;
    }
    idleTicks += 1;
    if (idleTicks * tickMs >= idleExitMs) {
      clearInterval(timer);
      onIdle();
    }
  }, tickMs);
  return () => clearInterval(timer);
}

export interface ServeOptions {
  readonly port: number;
  readonly source: SnapshotProvider;
  /** `idleExitSec` also sets when the server exits by itself. */
  readonly info: ServerInfo;
  readonly log: Logger;
}

/** Foreground server on 127.0.0.1. Resolves with the exit code on SIGINT/SIGTERM or idle exit. */
export async function serve(options: ServeOptions): Promise<number> {
  const app = createUsageServer({ source: options.source, info: options.info });
  try {
    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(options.port, LOOPBACK, () => {
        app.server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
    options.log('error', 'listen failed', { port: options.port, code });
    return 1;
  }
  options.log('info', 'listening', { url: `http://${LOOPBACK}:${options.port}/`, pid: process.pid, version: VERSION });

  return new Promise((resolve) => {
    const idleExitSec = options.info.idleExitSec;
    const stopIdleWatch = idleExitSec === null ? undefined : watchIdle(app.requests, idleExitSec * 1000, () => stop('idle'));
    const onSignal = (): void => stop('signal');
    function stop(reason: string): void {
      stopIdleWatch?.();
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      app.server.close();
      app.server.closeAllConnections();
      options.log('info', 'stopped', { reason });
      resolve(0);
    }
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

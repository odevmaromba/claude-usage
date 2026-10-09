import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { readAccount } from './account.js';
import { readCredentials } from './credentials.js';
import { toDisplay } from './display.js';
import { loadEnv, type Env } from './env.js';
import { usageError } from './errors.js';
import { jsonLogger } from './log.js';
import { cacheDir, claudeGlobalConfigFile } from './paths.js';
import { err, ok } from './result.js';
import { colorSupport, runOnce, runWatch } from './tui.js';
import { fetchUsage, UsagePayloadSchema } from './usage-api.js';
import { SHARED_READ_MS, UsageSource, type UsageSourceDeps } from './usage-source.js';
import { VERSION } from './version.js';
import { launchWeb } from './web/launcher.js';
import { serve } from './web/server.js';

const DEFAULT_PORT = 7177;
/** Measured 2026-10-09: polling every 60s got a 429 on half the calls. Claude Code's own background read is 5 min. */
const DEFAULT_INTERVAL_SEC = 300;
const IDLE_EXIT_SEC = 300;

const HELP = `claude-usage v${VERSION} — uso do plano Claude, pelo login do Claude Code

Uso
  claude-usage              tela no terminal
  claude-usage -w           tela ao vivo no terminal (r atualiza, q sai)
  claude-usage --web        abre a tela numa janela (servidor local em 127.0.0.1)
  claude-usage --json       resposta crua da API

Opções
  -i, --interval <s>   atualização do -w/--web, em segundos (padrão ${DEFAULT_INTERVAL_SEC}, mínimo 60)
  -p, --port <n>       porta do --web (padrão ${DEFAULT_PORT})
      --no-open        --web sem abrir a janela
      --idle-exit <s>  o servidor do --web fecha após <s> sem acessos (padrão ${IDLE_EXIT_SEC}, mínimo 60)
      --color          cores mesmo fora de um terminal
      --no-color       sem cores
      --serve          só o servidor, em primeiro plano (debug)
  -h, --help           esta ajuda
  -v, --version        versão

O token vem do login do Claude Code (Keychain "Claude Code-credentials"),
só leitura: nunca é renovado nem gravado aqui. Login expirado? Abra o
\`claude\` uma vez e rode de novo.`;

const OPTIONS = {
  watch: { type: 'boolean', short: 'w' },
  web: { type: 'boolean' },
  serve: { type: 'boolean' },
  json: { type: 'boolean' },
  interval: { type: 'string', short: 'i' },
  port: { type: 'string', short: 'p' },
  open: { type: 'boolean', default: true },
  color: { type: 'boolean' },
  'idle-exit': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

const IntervalSchema = z.coerce.number().int().min(60).max(3600);
const PortSchema = z.coerce.number().int().min(1024).max(65_535);
// At least twice the page poll (page.ts POLL_MS = 30s): at 30 an open window can lose the race with the idle tick.
const IdleExitSchema = z.coerce.number().int().min(60).max(86_400);

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function printError(line: string): void {
  process.stderr.write(`claude-usage: ${line}\n`);
}

function parseNumber(schema: z.ZodType<number>, raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Dev/test: `CLAUDE_USAGE_FIXTURE=<payload.json>` replaces Keychain + API; nothing is cached. */
function fixtureDeps(file: string): Pick<UsageSourceDeps, 'readCredentials' | 'fetchUsage'> {
  return {
    readCredentials: async () =>
      ok({
        accessToken: 'fixture',
        expiresAt: new Date(Date.now() + 8 * 3_600_000),
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
        source: 'fixture',
      }),
    fetchUsage: async () => {
      try {
        const parsed = UsagePayloadSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
        return parsed.success ? ok(parsed.data) : err(usageError('bad_response', 'Fixture com formato inválido.'));
      } catch {
        return err(usageError('bad_response', 'Não deu pra ler a fixture.'));
      }
    },
  };
}

function createSource(env: Env, maxAgeMs: number): UsageSource {
  const fixture = env.CLAUDE_USAGE_FIXTURE;
  const live: Pick<UsageSourceDeps, 'readCredentials' | 'fetchUsage'> = {
    readCredentials: () => readCredentials({ env }),
    fetchUsage: (accessToken) => fetchUsage(accessToken),
  };
  return new UsageSource({
    maxAgeMs,
    cacheFile: fixture ? null : join(cacheDir(env), 'last.json'),
    deps: {
      ...(fixture ? fixtureDeps(fixture) : live),
      readAccount: () => readAccount(claudeGlobalConfigFile(env)),
      now: Date.now,
    },
  });
}

export interface MainContext {
  /** Absolute path of the bin entry; `--web` re-runs it detached with `--serve`. */
  readonly entry: string;
}

export async function main(argv: readonly string[], context: MainContext): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args: [...argv], options: OPTIONS, allowNegative: true, allowPositionals: false, strict: true }));
  } catch (error) {
    printError(`${error instanceof Error ? error.message : String(error)}\nVeja claude-usage --help.`);
    return 2;
  }

  if (values.help) {
    print(HELP);
    return 0;
  }
  if (values.version) {
    print(VERSION);
    return 0;
  }
  if ([values.watch, values.web, values.serve, values.json].filter(Boolean).length > 1) {
    printError('use um modo só: -w, --web, --serve ou --json.');
    return 2;
  }

  const intervalSec = parseNumber(IntervalSchema, values.interval, DEFAULT_INTERVAL_SEC);
  if (intervalSec === null) {
    printError('--interval aceita de 60 a 3600 segundos.');
    return 2;
  }
  const port = parseNumber(PortSchema, values.port, DEFAULT_PORT);
  if (port === null) {
    printError('--port aceita de 1024 a 65535.');
    return 2;
  }
  const idleExitSec = values['idle-exit'] === undefined ? null : parseNumber(IdleExitSchema, values['idle-exit'], 0);
  if (values['idle-exit'] !== undefined && idleExitSec === null) {
    printError('--idle-exit aceita de 60 a 86400 segundos.');
    return 2;
  }

  const env = loadEnv();
  const intervalMs = intervalSec * 1000;
  const fixture = env.CLAUDE_USAGE_FIXTURE !== undefined;

  if (values.serve) {
    return serve({
      port,
      // Page polls every 30s; at most one API call per interval.
      source: createSource(env, intervalMs),
      info: { fixture, intervalSec, idleExitSec },
      log: jsonLogger(process.stderr),
    });
  }

  if (values.web) {
    return launchWeb({
      port,
      intervalSec,
      idleExitSec: idleExitSec ?? IDLE_EXIT_SEC,
      fixture,
      open: values.open,
      cliPath: context.entry,
      version: VERSION,
      logFile: join(cacheDir(env), 'server.log'),
      print,
      printError,
    });
  }

  if (values.json) {
    const snapshot = await createSource(env, SHARED_READ_MS).get();
    if (snapshot.payload) print(JSON.stringify(snapshot.payload, null, 2));
    // The notice says how old the payload above is when it is the cached one.
    const notice = snapshot.error ? toDisplay(snapshot, new Date()).notice : null;
    if (notice) printError(notice.hint ? `${notice.message} ${notice.hint}` : notice.message);
    return snapshot.error ? 1 : 0;
  }

  const support = colorSupport(env, process.stdout.isTTY === true);
  const terminal = { color: values.color ?? support.color, richColor: support.rich };

  if (values.watch) {
    if (env.TERM === 'dumb') {
      printError('-w precisa de um terminal que mova o cursor (TERM=dumb não move); rode sem -w.');
      return 2;
    }
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      printError('-w precisa de um terminal interativo.');
      return 2;
    }
    // Slightly under the interval so timer jitter never skips a cycle.
    const code = await runWatch(createSource(env, Math.max(1_000, intervalMs - 2_000)), { ...terminal, intervalMs });
    // runWatch already gave a request in flight QUIT_GRACE_MS to persist; leave now instead of waiting out its 10s timeout. stdout is a TTY, so nothing is pending.
    process.exit(code);
  }

  return runOnce(createSource(env, SHARED_READ_MS), terminal);
}

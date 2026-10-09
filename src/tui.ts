import type { Display, DisplayBreakdown, DisplayCredits, DisplayLimit, DisplayNotice } from './display.js';
import { toDisplay } from './display.js';
import type { Env } from './env.js';
import type { Snapshot, SnapshotProvider } from './usage-source.js';
import type { Severity } from './usage-view.js';

export interface RenderOptions {
  readonly columns: number;
  /** Terminal height (watch mode): the frame is compacted to fit and has no trailing newline. */
  readonly rows?: number;
  readonly color: boolean;
  /** 256-color terminal: accent in Claude terracotta instead of cyan. */
  readonly richColor?: boolean;
  readonly footer?: string | null;
}

const MIN_WIDTH = 28;
const MAX_WIDTH = 64;
/** Narrower than this, lines wrap no matter what. */
const NARROW_MIN_WIDTH = 21;
const INDENT = '  ';
const PARTIAL_BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const;
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;

type Paint = (text: string) => string;

interface Palette {
  readonly bold: Paint;
  readonly dim: Paint;
  readonly accent: Paint;
  readonly warn: Paint;
  readonly crit: Paint;
  readonly code: Paint;
}

function palette(color: boolean, rich: boolean): Palette {
  const wrap =
    (open: string, close: string): Paint =>
    (text) =>
      color && text.length > 0 ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return {
    bold: wrap('1', '22'),
    dim: wrap('2', '22'),
    accent: wrap(rich ? '38;5;173' : '36', '39'),
    warn: wrap('33', '39'),
    crit: wrap('31', '39'),
    code: wrap(rich ? '1;38;5;173' : '1;36', '22;39'),
  };
}

function tone(severity: Severity, paint: Palette): Paint {
  if (severity === 'critical') return paint.crit;
  if (severity === 'warning') return paint.warn;
  return paint.accent;
}

/** NO_COLOR wins, FORCE_COLOR next (`0`/`false` turn color off), else only on a real terminal. */
export function colorSupport(env: Env, isTTY: boolean): { color: boolean; rich: boolean } {
  const force = env.FORCE_COLOR;
  const rich = force === '2' || force === '3' || /256|truecolor|24bit|ghostty|kitty|wezterm/i.test(`${env.TERM ?? ''} ${env.COLORTERM ?? ''}`);
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return { color: false, rich };
  if (force !== undefined) return { color: force !== '0' && force !== 'false', rich };
  return { color: isTTY && env.TERM !== 'dumb', rich };
}

export function visibleLength(text: string): number {
  return [...text.replace(ANSI_PATTERN, '')].length;
}

export function truncate(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  if (max <= 0) return '';
  return `${chars.slice(0, max - 1).join('')}…`;
}

/** Bar with 1/8-cell precision. Over 100% renders full. */
export function renderBar(percent: number, width: number): { filled: string; empty: string } {
  const cells = Math.max(1, Math.floor(width));
  const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  const eighths = Math.round((clamped / 100) * cells * 8);
  const full = Math.floor(eighths / 8);
  const partial = PARTIAL_BLOCKS[eighths % 8] ?? '';
  const used = full + (partial ? 1 : 0);
  return { filled: '█'.repeat(full) + partial, empty: '░'.repeat(Math.max(0, cells - used)) };
}

interface Run {
  readonly text: string;
  /** Between backticks: a command. */
  readonly code: boolean;
}

/** Text between spaces; backticks inside only switch runs, so "(`claude`)," stays one word. */
type Word = readonly Run[];

function toWords(text: string): Word[] {
  const words: Run[][] = [];
  let word: Run[] = [];
  let code = false;
  for (const piece of text.split(/(`|\s+)/)) {
    if (piece === '`') {
      code = !code;
    } else if (/^\s+$/.test(piece)) {
      if (word.length > 0) words.push(word);
      word = [];
    } else if (piece) {
      word.push({ text: piece, code });
    }
  }
  if (word.length > 0) words.push(word);
  return words;
}

function wordLength(word: Word): number {
  return word.reduce((total, run) => total + [...run.text].length, 0);
}

/** A word longer than the line is cut, ellipsis included. */
function fitWord(word: Word, width: number): Word {
  if (wordLength(word) <= width) return word;
  const runs: Run[] = [];
  let room = Math.max(0, width - 1);
  for (const run of word) {
    const chars = [...run.text].slice(0, room);
    if (chars.length > 0) runs.push({ text: chars.join(''), code: run.code });
    room -= chars.length;
  }
  return [...runs, { text: '…', code: false }];
}

function wrapWords(words: readonly Word[], width: number): Word[][] {
  const lines: Word[][] = [];
  let line: Word[] = [];
  let length = 0;
  for (const word of words) {
    const fitted = fitWord(word, width);
    const size = wordLength(fitted);
    if (line.length > 0 && length + 1 + size > width) {
      lines.push(line);
      line = [];
      length = 0;
    }
    line.push(fitted);
    length += (line.length > 1 ? 1 : 0) + size;
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

function paintWords(line: readonly Word[], base: Paint, paint: Palette): string {
  return line
    .map((word) => word.map((run) => (run.code ? paint.code(run.text) : base(run.text))).join(''))
    .join(base(' '));
}

function limitBlock(limit: DisplayLimit, width: number, paint: Palette): string[] {
  const value = `${limit.percent}%`;
  const room = Math.max(1, width - value.length - 1);
  let label = limit.label;
  let detail = limit.detail ? ` · ${limit.detail}` : '';
  const labelLength = [...label].length;
  if (labelLength + [...detail].length > room) {
    if (room - labelLength >= 6) {
      detail = truncate(detail, room - labelLength);
    } else {
      detail = '';
      label = truncate(label, room);
    }
  }
  const gap = Math.max(1, width - [...label].length - [...detail].length - value.length);
  const color = tone(limit.severity, paint);
  const bar = renderBar(limit.percent, width);
  return [
    paint.bold(label) + paint.dim(detail) + ' '.repeat(gap) + paint.bold(color(value)),
    color(bar.filled) + paint.dim(bar.empty),
    paint.dim(truncate(resetText(limit), width)),
  ];
}

export function resetText(limit: DisplayLimit): string {
  if (limit.resetPassed && limit.resetAt) return `renovou ${limit.resetAt} · número anterior à renovação`;
  if (limit.resetIn && limit.resetAt) return `renova em ${limit.resetIn} · ${limit.resetAt}`;
  return 'sem horário de renovação';
}

function breakdownBlock(breakdown: DisplayBreakdown, width: number, paint: Palette): string[] {
  const title = breakdown.since ? `Semana por superfície · desde ${breakdown.since}` : 'Semana por superfície';
  const lines = [paint.bold(truncate(title, width))];
  const used = breakdown.rows.filter((row) => row.percent > 0);
  const idle = breakdown.rows.filter((row) => row.percent <= 0);
  if (used.length === 0) {
    lines.push(paint.dim(truncate('sem uso registrado nesta semana', width)));
    return lines;
  }
  // Bar keeps at least 4 cells; label, bar and the 4-char value then add up to `width`.
  const labelWidth = Math.max(1, Math.min(14, width - 10, Math.max(...used.map((row) => [...row.label].length))));
  const barWidth = Math.max(4, width - labelWidth - 6);
  for (const row of used) {
    const bar = renderBar(row.percent, barWidth);
    const label = truncate(row.label, labelWidth).padEnd(labelWidth);
    lines.push(`${label} ${paint.accent(bar.filled)}${paint.dim(bar.empty)} ${`${row.percent}%`.padStart(4)}`);
  }
  if (idle.length > 0) lines.push(paint.dim(truncate(`${idle.map((row) => row.label).join(', ')}: 0%`, width)));
  return lines;
}

function creditsLine(credits: DisplayCredits, width: number, paint: Palette): string {
  const percent = credits.enabled && credits.percent !== null ? ` · ${credits.percent}%` : '';
  const text = truncate(`Créditos de uso: ${credits.summary}${percent}`, width);
  return credits.enabled ? tone(credits.severity, paint)(text) : paint.dim(text);
}

function noticeBlock(notice: DisplayNotice, width: number, paint: Palette): string[] {
  const base = notice.level === 'error' ? paint.crit : paint.warn;
  const lines = wrapWords(toWords(`! ${notice.message}`), width).map((line) => paintWords(line, base, paint));
  if (notice.hint) {
    lines.push(...wrapWords(toWords(notice.hint), width - 2).map((line) => `  ${paintWords(line, (text) => text, paint)}`));
  }
  return lines;
}

function statusText(display: Display): string {
  const updated = display.updatedAt
    ? `atualizado ${display.updatedAt}${display.updatedAgo ? ` (${display.updatedAgo})` : ''}`
    : 'sem dados ainda';
  return display.loginStatus ? `${updated} · ${display.loginStatus}` : updated;
}

/** Content width and left margin; a narrow terminal loses the margin instead of wrapping lines. */
function geometry(columns: number): { width: number; indent: string } {
  // A pty that never got a window size reports 0 columns: treat it as unknown, like a pipe.
  const total = Number.isFinite(columns) && columns >= 1 ? Math.floor(columns) : 80;
  const available = total - INDENT.length * 2;
  if (available >= MIN_WIDTH) return { width: Math.min(MAX_WIDTH, available), indent: INDENT };
  // One spare column: a line that ends on the last one makes some terminals wrap early.
  return { width: Math.max(NARROW_MIN_WIDTH, total - 1), indent: '' };
}

interface Block {
  readonly lines: readonly string[];
  /** First to go when the frame is taller than the terminal. */
  readonly optional: boolean;
  /** Kept right above the status line when the body is clipped (a stale-data notice). */
  readonly pinned?: boolean;
}

/**
 * Watch mode: a frame taller than the terminal scrolls the alt screen and tears
 * every redraw. Drops blank lines, then optional blocks, then clips the body
 * from the bottom but keeps pinned blocks; the status line and footer always
 * stay on the last rows.
 */
function fitRows(blocks: readonly Block[], tail: readonly string[], rows: number): string[] {
  const body = (all: boolean, spaced: boolean): string[] =>
    blocks.filter((block) => all || !block.optional).flatMap((block) => (spaced ? [...block.lines, ''] : block.lines));
  const candidates = [['', ...body(true, true), ...tail], [...body(true, false), ...tail], [...body(false, false), ...tail]];
  const fit = candidates.find((lines) => lines.length <= rows);
  if (fit) return fit;
  const room = Math.max(0, rows - tail.length);
  const kept = blocks.filter((block) => !block.optional);
  const pinned = kept.filter((block) => block.pinned).flatMap((block) => block.lines).slice(0, room);
  const rest = kept.filter((block) => !block.pinned).flatMap((block) => block.lines);
  return [...rest.slice(0, room - pinned.length), ...pinned, ...tail].slice(-rows);
}

export function renderScreen(display: Display, options: RenderOptions): string {
  const paint = palette(options.color, options.richColor ?? false);
  const { width, indent } = geometry(options.columns);
  const blocks: Block[] = [];

  const plan = display.plan ? truncate(display.plan, 16) : '';
  const title = truncate('CLAUDE · USO DO PLANO', width - [...plan].length - 1);
  const titleGap = Math.max(1, width - [...title].length - [...plan].length);
  const header = [paint.bold(title) + (plan ? ' '.repeat(titleGap) + paint.accent(plan) : '')];
  if (display.email) header.push(paint.dim(truncate(display.email, width)));
  blocks.push({ lines: header, optional: false });

  if (display.limits.length === 0) {
    const empty = display.hasData ? 'A API não retornou limites.' : 'Sem dados de uso.';
    blocks.push({ lines: [paint.dim(truncate(empty, width))], optional: false });
  }
  for (const limit of display.limits) blocks.push({ lines: limitBlock(limit, width, paint), optional: false });
  if (display.breakdown) blocks.push({ lines: breakdownBlock(display.breakdown, width, paint), optional: true });
  if (display.credits) blocks.push({ lines: [creditsLine(display.credits, width, paint)], optional: true });
  if (display.notice) blocks.push({ lines: noticeBlock(display.notice, width, paint), optional: false, pinned: true });
  const tail = [paint.dim(truncate(statusText(display), width))];
  if (options.footer) tail.push(paint.dim(truncate(options.footer, width)));

  const lines =
    options.rows === undefined
      ? ['', ...blocks.flatMap((block) => [...block.lines, '']), ...tail, '']
      : fitRows(blocks, tail, Math.max(1, Math.floor(options.rows)));
  return lines.map((line) => (line ? indent + line : line)).join('\n');
}

/** Watch footer: "45s", "4min 05s". */
export function countdown(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}min ${String(seconds % 60).padStart(2, '0')}s`;
}

export interface TerminalOptions {
  readonly color: boolean;
  readonly richColor: boolean;
}

/** One frame to stdout. Exit code 1 when the API call failed (even if cached data was shown). */
export async function runOnce(source: SnapshotProvider, options: TerminalOptions): Promise<number> {
  const snapshot = await source.get();
  const frame = renderScreen(toDisplay(snapshot, new Date()), {
    columns: process.stdout.columns ?? 80,
    color: options.color,
    richColor: options.richColor,
  });
  process.stdout.write(`${frame}\n`);
  return snapshot.error ? 1 : 0;
}

const ALT_SCREEN_ON = '\u001b[?1049h\u001b[?25l';
const ALT_SCREEN_OFF = '\u001b[?25h\u001b[?1049l';
const HOME = '\u001b[H';
const CLEAR_LINE_END = '\u001b[K';
const CLEAR_BELOW = '\u001b[J';
const CTRL_C = '\u0003';
const ESC = '\u001b';
/** Lands the redraw just past the second boundary, never just before it. */
const TICK_SLACK_MS = 15;
/** After a 429 hold, wake this long past its end so the source sees it over. */
const HOLD_SLACK_MS = 1_000;
/** Plus up to this much at random: every `-w` shares the hold's end, and waking together means calling together. */
const HOLD_JITTER_MS = 30_000;
/** On quit, how long a request already on the wire gets to land in the shared cache (`last.json`/`backoff.json`). */
const QUIT_GRACE_MS = 1_000;
/** 128 + signal number, as shells report a process killed by it. */
const EXIT_SIGNALS: ReadonlyArray<readonly [NodeJS.Signals, number]> = [
  ['SIGHUP', 129],
  ['SIGINT', 130],
  ['SIGQUIT', 131],
  ['SIGTERM', 143],
];

/**
 * Full-screen live view. `r` refreshes, `q`/Esc/Ctrl+C quits (code 0); a
 * signal quits with 128 + its number. Requires a TTY on stdin and stdout.
 */
export function runWatch(source: SnapshotProvider, options: TerminalOptions & { readonly intervalMs: number }): Promise<number> {
  const output = process.stdout;
  const input = process.stdin;
  let snapshot: Snapshot | null = null;
  let busy = false;
  let closed = false;
  let lastFrame = '';
  let nextFetchAt = 0;
  let fetchTimer: NodeJS.Timeout | undefined;
  let tickTimer: NodeJS.Timeout | undefined;
  let inflight: Promise<unknown> = Promise.resolve();

  const draw = (force = false): void => {
    if (closed) return;
    const now = new Date();
    // 0 rows (pty with no window size) is unknown, not a 1-row terminal.
    const rows = output.rows >= 1 ? Math.floor(output.rows) : 24;
    const display = snapshot ? toDisplay(snapshot, now) : null;
    const seconds = Math.max(0, Math.ceil((nextFetchAt - now.getTime()) / 1000));
    // Keys first: on a narrow pane truncation eats the end of the countdown, not how to quit.
    const footer = busy ? 'atualizando…' : `r atualiza · q sai · próxima em ${countdown(seconds)}`;
    const lines = display
      ? renderScreen(display, { columns: output.columns ?? 80, rows, color: options.color, richColor: options.richColor, footer }).split('\n')
      : ['', `${INDENT}carregando…`];
    // No newline after the last row: on the bottom line it would scroll the screen.
    const frame = lines.slice(-rows).join(`${CLEAR_LINE_END}\n`);
    if (!force && frame === lastFrame) return;
    lastFrame = frame;
    output.write(`${HOME}${frame}${CLEAR_LINE_END}${CLEAR_BELOW}`);
  };

  /** Redraws right after each whole second of the countdown, so it never skips or repeats a number. */
  const tick = (): void => {
    clearTimeout(tickTimer);
    if (closed) return;
    const left = nextFetchAt - Date.now();
    const delay = left > 0 ? (left % 1000 || 1000) + TICK_SLACK_MS : 1000;
    tickTimer = setTimeout(() => {
      draw();
      tick();
    }, delay);
  };

  const refresh = async (force: boolean): Promise<void> => {
    if (busy || closed) return;
    busy = true;
    // The next cycle counts from here, not from the answer: a period stretched by each request's
    // own time drifts this -w into another's phase, and two -w in phase both call.
    const startedAt = Date.now();
    clearTimeout(fetchTimer);
    draw();
    try {
      const request = source.get({ force });
      inflight = request;
      snapshot = await request;
    } catch {
      // UsageSource reports failures inside the snapshot; anything else keeps the last frame.
    } finally {
      busy = false;
      if (!closed) {
        // During a 429 hold, wake when it ends: a cycle before that would not call the API.
        const retryAt = snapshot?.retryAt?.getTime();
        const holdEnd = retryAt === undefined ? 0 : retryAt + HOLD_SLACK_MS + Math.floor(Math.random() * HOLD_JITTER_MS);
        nextFetchAt = Math.max(startedAt + options.intervalMs, holdEnd);
        fetchTimer = setTimeout(() => void refresh(false), Math.max(0, nextFetchAt - Date.now()));
        draw();
        tick();
      }
    }
  };

  return new Promise((resolve) => {
    const onResize = (): void => draw(true);
    const onKey = (key: string): void => {
      if (key === 'q' || key === 'Q' || key === CTRL_C || key === ESC) quit(0);
      else if (key === 'r' || key === 'R') void refresh(true);
    };
    const restore = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(tickTimer);
      clearTimeout(fetchTimer);
      output.off('resize', onResize);
      input.off('data', onKey);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      output.write(ALT_SCREEN_OFF);
    };
    // Without these, `kill -INT` and friends would leave the terminal on the alt screen with no cursor.
    const onSignals = EXIT_SIGNALS.map(([signal, code]) => [signal, (): void => quit(code)] as const);
    const quit = (code: number): void => {
      restore();
      for (const [signal, handler] of onSignals) process.off(signal, handler);
      process.off('exit', restore);
      // The API already counted a request on the wire: let it reach the shared files, or the next process calls again.
      const leave = (): void => {
        clearTimeout(grace);
        resolve(code);
      };
      const grace = setTimeout(leave, QUIT_GRACE_MS);
      void inflight.then(leave, leave);
    };

    process.on('exit', restore);
    for (const [signal, handler] of onSignals) process.once(signal, handler);
    output.write(ALT_SCREEN_ON);
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.on('data', onKey);
    input.resume();
    output.on('resize', onResize);
    tick();
    void refresh(false);
  });
}

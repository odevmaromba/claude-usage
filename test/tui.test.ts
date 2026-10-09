import { describe, expect, it } from 'vitest';
import { toDisplay } from '../src/display.js';
import { loadEnv } from '../src/env.js';
import { HINTS, rateLimitedError, usageError } from '../src/errors.js';
import { colorSupport, countdown, renderBar, renderScreen, resetText, truncate, visibleLength } from '../src/tui.js';
import type { Snapshot } from '../src/usage-source.js';
import { CAPTURED_AT as NOW, loadFixture, stripAnsi, TZ } from './helpers.js';

const REAL = loadFixture('usage-2026-10-07.json');

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    payload: REAL,
    fetchedAt: NOW,
    error: null,
    plan: 'Max 20x',
    tokenExpiresAt: new Date('2026-10-07T22:56:00Z'),
    account: { email: 'dev@example.com', displayName: null },
    credentialsSource: 'keychain',
    retryAt: null,
    ...overrides,
  };
}

describe('renderBar', () => {
  it('fills with 1/8-cell precision', () => {
    expect(renderBar(0, 10)).toEqual({ filled: '', empty: '░'.repeat(10) });
    expect(renderBar(100, 10)).toEqual({ filled: '█'.repeat(10), empty: '' });
    expect(renderBar(50, 10)).toEqual({ filled: '█████', empty: '░░░░░' });
    expect(renderBar(14, 10)).toEqual({ filled: '█▍', empty: '░'.repeat(8) });
  });

  it('clamps junk and overflow', () => {
    expect(renderBar(104, 8).filled).toBe('█'.repeat(8));
    expect(renderBar(-3, 8).filled).toBe('');
    expect(renderBar(Number.NaN, 8).filled).toBe('');
    expect(renderBar(50, 0)).toEqual({ filled: '▌', empty: '' });
  });

  it('always spans the full width', () => {
    for (let percent = 0; percent <= 100; percent += 1) {
      const bar = renderBar(percent, 37);
      expect([...bar.filled].length + bar.empty.length).toBe(37);
    }
  });
});

describe('text helpers', () => {
  it('measures without ANSI codes', () => {
    expect(visibleLength('\u001b[1;38;5;173mSessão\u001b[22;39m')).toBe(6);
  });

  it('truncates with an ellipsis', () => {
    expect(truncate('Sessão atual', 20)).toBe('Sessão atual');
    expect(truncate('Sessão atual', 7)).toBe('Sessão…');
    expect(truncate('abc', 0)).toBe('');
  });
});

describe('countdown', () => {
  it('counts the watch footer down in minutes and seconds past a minute', () => {
    expect(countdown(0)).toBe('0s');
    expect(countdown(59)).toBe('59s');
    expect(countdown(60)).toBe('1min 00s');
    expect(countdown(299)).toBe('4min 59s');
    expect(countdown(1801)).toBe('30min 01s');
  });
});

describe('colorSupport', () => {
  it('honors NO_COLOR, FORCE_COLOR, TTY and TERM=dumb', () => {
    expect(colorSupport(loadEnv({ NO_COLOR: '1', FORCE_COLOR: '1' }), true).color).toBe(false);
    expect(colorSupport(loadEnv({ FORCE_COLOR: '1' }), false).color).toBe(true);
    expect(colorSupport(loadEnv({ FORCE_COLOR: '0' }), false).color).toBe(false);
    expect(colorSupport(loadEnv({ FORCE_COLOR: '0' }), true).color).toBe(false);
    expect(colorSupport(loadEnv({ FORCE_COLOR: 'false' }), true).color).toBe(false);
    expect(colorSupport(loadEnv({ FORCE_COLOR: '' }), false).color).toBe(true);
    expect(colorSupport(loadEnv({ FORCE_COLOR: '3', TERM: 'xterm' }), false).rich).toBe(true);
    expect(colorSupport(loadEnv({}), true).color).toBe(true);
    expect(colorSupport(loadEnv({ TERM: 'dumb' }), true).color).toBe(false);
    expect(colorSupport(loadEnv({ TERM: 'xterm-256color' }), true).rich).toBe(true);
    expect(colorSupport(loadEnv({ TERM: 'xterm' }), true).rich).toBe(false);
  });
});

const FOOTER = 'próxima em 59s · r atualiza · q sai';

describe('renderScreen', () => {
  const display = toDisplay(snapshot(), NOW, TZ);

  it('renders every limit with its bar and reset line', () => {
    const screen = renderScreen(display, { columns: 80, color: false });
    const lines = screen.split('\n');
    expect(lines).toContain('  CLAUDE · USO DO PLANO                                    Max 20x');
    expect(lines).toContain('  Sessão atual · janela de 5h                                  14%');
    expect(lines).toContain('  renova em 4h 29min · hoje 16:50');
    expect(lines).toContain('  Semana · só Fable                                             0%');
    expect(lines).toContain('  renova em 2d 12h · sáb 10/10 01:00');
    expect(lines.some((line) => line.startsWith('  Claude Code ') && line.endsWith(' 100%'))).toBe(true);
    expect(lines).toContain('  Chat, Cowork, Outros: 0%');
    expect(lines).toContain('  Créditos de uso: desativados');
    expect(lines).toContain('  atualizado 12:20 (agora) · login até hoje 19:56');
  });

  it.each([32, 40, 66, 80, 200])('never draws past the content width at %d columns', (columns) => {
    const lines = renderScreen(display, { columns, color: true, footer: FOOTER }).split('\n');
    const width = Math.min(64, columns - 4);
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(width + 2);
  });

  it.each([22, 25, 28, 31])('drops the margin instead of wrapping at %d columns', (columns) => {
    const busy = toDisplay(
      snapshot({
        error: rateLimitedError(),
        retryAt: new Date(NOW.getTime() + 5 * 60_000),
        payload: { ...REAL, seven_day_breakdown: { rows: [{ key: 'chat', percent: 0 }, { key: 'surface_with_a_long_name', percent: 7 }] } },
      }),
      NOW,
      TZ,
    );
    for (const target of [display, busy, toDisplay(snapshot({ payload: {} }), NOW, TZ)]) {
      for (const rows of [undefined, 12]) {
        const lines = renderScreen(target, { columns, rows, color: true, footer: FOOTER }).split('\n');
        for (const line of lines) expect(visibleLength(line)).toBeLessThan(columns);
      }
    }
    expect(renderScreen(display, { columns, color: false }).split('\n')[1]?.startsWith('CLAUDE')).toBe(true);
  });

  describe('fitted to the terminal height (watch mode)', () => {
    const full = renderScreen(display, { columns: 80, color: false, footer: FOOTER }).split('\n');
    const fitted = (rows: number): string[] => renderScreen(display, { columns: 80, rows, color: false, footer: FOOTER }).split('\n');

    it('keeps the spaced layout when it fits, minus the trailing newline', () => {
      expect(fitted(full.length - 1)).toEqual(full.slice(0, -1));
      expect(fitted(200)).toEqual(full.slice(0, -1));
    });

    it('drops blank lines first, then breakdown and credits', () => {
      const dense = fitted(full.length - 2);
      expect(dense).toEqual(full.filter((line) => line !== ''));
      const lean = fitted(dense.length - 1);
      expect(lean.join('\n')).not.toContain('Semana por superfície');
      expect(lean.join('\n')).not.toContain('Créditos de uso');
      expect(lean.join('\n')).toContain('Semana · só Fable');
      expect(lean.length).toBeLessThan(dense.length);
    });

    it('clips the body but keeps status and footer on the last rows', () => {
      for (const rows of [1, 2, 5, 8]) {
        const lines = fitted(rows);
        expect(lines).toHaveLength(rows);
        expect(lines.at(-1)).toBe(`  ${FOOTER}`);
      }
      expect(fitted(8).at(-2)).toContain('atualizado 12:20');
      expect(fitted(8)[0]).toContain('CLAUDE · USO DO PLANO');
    });

    it('clips the limits before a stale-data notice', () => {
      const stale = toDisplay(snapshot({ error: usageError('token_expired', 'O login do Claude Code expirou.', HINTS.renew) }), NOW, TZ);
      const at = (rows: number): string[] => renderScreen(stale, { columns: 80, rows, color: false, footer: FOOTER }).split('\n');
      for (const rows of [13, 8, 5]) {
        const lines = at(rows);
        expect(lines).toHaveLength(rows);
        expect(lines.at(-1)).toBe(`  ${FOOTER}`);
        expect(lines.at(-3)).toContain('Abra o claude uma vez');
        expect(lines.at(-4)).toContain('! O login do Claude Code expirou. Mostrando dados de 12:20.');
      }
      expect(at(13)[0]).toContain('CLAUDE · USO DO PLANO');
      expect(at(3)[0]).toContain('! O login do Claude Code expirou.');
    });
  });

  it('emits ANSI only when color is on', () => {
    expect(renderScreen(display, { columns: 80, color: false })).not.toContain('\u001b[');
    const colored = renderScreen(display, { columns: 80, color: true, richColor: true });
    expect(colored).toContain('\u001b[38;5;173m');
    expect(stripAnsi(colored)).toBe(renderScreen(display, { columns: 80, color: false }));
  });

  it('wraps notices and paints commands instead of showing backticks', () => {
    const stale = toDisplay(
      snapshot({ error: usageError('token_expired', 'O login do Claude Code expirou.', HINTS.renew) }),
      NOW,
      TZ,
    );
    const plain = renderScreen(stale, { columns: 40, color: false });
    expect(plain).not.toContain('`');
    expect(plain).toContain('! O login do Claude Code expirou.');
    expect(plain).toContain('Abra o claude uma vez');
    const colored = renderScreen(stale, { columns: 40, color: true });
    expect(colored).toContain('\u001b[1;36mclaude\u001b[22;39m');
  });

  it('keeps punctuation glued to a command', () => {
    const fixture = toDisplay(snapshot({ credentialsSource: 'fixture' }), NOW, TZ);
    const plain = renderScreen(fixture, { columns: 80, color: false });
    expect(plain).toContain('! Dados de fixture (CLAUDE_USAGE_FIXTURE), não da sua conta.');
    const colored = renderScreen(fixture, { columns: 80, color: true });
    expect(colored).toContain('\u001b[33m(\u001b[39m\u001b[1;36mCLAUDE_USAGE_FIXTURE\u001b[22;39m\u001b[33m),\u001b[39m');
  });

  it('draws breakdown keys named after Object.prototype members', () => {
    const payload = {
      ...REAL,
      seven_day_breakdown: { rows: [{ key: 'constructor', percent: 5 }, { key: '__proto__', percent: 0 }] },
    };
    const screen = renderScreen(toDisplay(snapshot({ payload }), NOW, TZ), { columns: 80, color: false });
    const lines = screen.split('\n');
    expect(lines.some((line) => line.startsWith('  Constructor ') && line.endsWith('  5%'))).toBe(true);
    expect(lines).toContain('  Proto: 0%');
  });

  it('explains an empty screen', () => {
    const empty = toDisplay(
      snapshot({ payload: null, fetchedAt: null, error: usageError('no_credentials', 'Nenhum login do Claude Code encontrado.', HINTS.login) }),
      NOW,
      TZ,
    );
    const screen = renderScreen(empty, { columns: 80, color: false });
    expect(screen).toContain('Sem dados de uso.');
    expect(screen).toContain('! Nenhum login do Claude Code encontrado.');
    expect(screen).toContain('Rode claude e faça /login com a conta claude.ai.');
    expect(screen).toContain('sem dados ainda');
  });
});

describe('resetText', () => {
  it('covers passed and unknown resets', () => {
    const base = { id: 'x', label: 'Semana', detail: null, percent: 1, severity: 'normal' as const };
    expect(resetText({ ...base, resetIn: null, resetAt: 'hoje 16:50', resetPassed: true })).toBe(
      'renovou hoje 16:50 · número anterior à renovação',
    );
    expect(resetText({ ...base, resetIn: null, resetAt: null, resetPassed: false })).toBe('sem horário de renovação');
  });
});

describe('terminal with no window size (0x0 pty)', () => {
  const display = toDisplay(snapshot(), NOW, TZ);
  it('renders 0 columns as the default 80, not the narrow layout', () => {
    expect(renderScreen(display, { columns: 0, color: false })).toBe(renderScreen(display, { columns: 80, color: false }));
  });
});

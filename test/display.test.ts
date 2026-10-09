import { describe, expect, it } from 'vitest';
import { toDisplay } from '../src/display.js';
import { HINTS, rateLimitedError, usageError } from '../src/errors.js';
import type { Snapshot } from '../src/usage-source.js';
import { CAPTURED_AT as NOW, loadFixture, TZ } from './helpers.js';

const REAL = loadFixture('usage-2026-10-07.json');

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    payload: REAL,
    fetchedAt: new Date(NOW.getTime() - 3 * 60_000),
    error: null,
    plan: 'Max 20x',
    tokenExpiresAt: new Date('2026-10-07T22:56:00Z'),
    account: { email: 'dev@example.com', displayName: null },
    credentialsSource: 'keychain',
    retryAt: null,
    ...overrides,
  };
}

describe('toDisplay', () => {
  it('formats the real payload for São Paulo', () => {
    const display = toDisplay(snapshot(), NOW, TZ);
    expect(display).toMatchObject({
      hasData: true,
      plan: 'Max 20x',
      email: 'dev@example.com',
      updatedAt: '12:17',
      updatedAgo: 'há 3 min',
      loginStatus: 'login até hoje 19:56',
      notice: null,
      credits: { enabled: false, summary: 'desativados', percent: null, severity: 'normal' },
      breakdown: { since: 'sáb 03/10 01:00' },
    });
    expect(display.limits).toEqual([
      {
        id: 'session-0',
        label: 'Sessão atual',
        detail: 'janela de 5h',
        percent: 14,
        severity: 'normal',
        resetIn: '4h 29min',
        resetAt: 'hoje 16:50',
        resetPassed: false,
      },
      {
        id: 'weekly_all-1',
        label: 'Semana',
        detail: 'todos os modelos',
        percent: 4,
        severity: 'normal',
        resetIn: '2d 12h',
        resetAt: 'sáb 10/10 01:00',
        resetPassed: false,
      },
      {
        id: 'weekly_scoped-2',
        label: 'Semana',
        detail: 'só Fable',
        percent: 0,
        severity: 'normal',
        resetIn: '2d 12h',
        resetAt: 'sáb 10/10 01:00',
        resetPassed: false,
      },
    ]);
  });

  it('is plain JSON (the web page receives it as is)', () => {
    const display = toDisplay(snapshot(), NOW, TZ);
    expect(JSON.parse(JSON.stringify(display))).toEqual(display);
  });

  it('shows the minute a jittered reset time means', () => {
    const jittered = {
      limits: [{ kind: 'weekly_all', group: 'weekly', percent: 12, resets_at: '2026-10-10T03:59:59.830867+00:00' }],
      seven_day_breakdown: { window_started_at: '2026-10-03T03:59:59.830867+00:00', rows: [{ key: 'chat', percent: 1 }] },
    };
    const display = toDisplay(snapshot({ payload: jittered }), NOW, TZ);
    expect(display.limits[0]).toMatchObject({ resetAt: 'sáb 10/10 01:00', resetIn: '2d 12h' });
    expect(display.breakdown?.since).toBe('sáb 03/10 01:00');
  });

  it('flags a reset that already passed (stale cache)', () => {
    const later = new Date('2026-10-07T20:30:00Z');
    const [session] = toDisplay(snapshot(), later, TZ).limits;
    expect(session).toMatchObject({ resetIn: null, resetAt: 'hoje 16:50', resetPassed: true });
  });

  it('turns an error with cached data into a warning that says how old the data is', () => {
    const display = toDisplay(
      snapshot({ error: usageError('token_expired', 'O login do Claude Code expirou.', HINTS.renew) }),
      NOW,
      TZ,
    );
    expect(display.notice).toEqual({
      level: 'warning',
      code: 'token_expired',
      message: 'O login do Claude Code expirou. Mostrando dados de 12:17.',
      hint: HINTS.renew,
    });
    expect(display.limits).toHaveLength(3);
  });

  it('says when the next call is allowed during a 429 hold, as a clock time rounded up', () => {
    const held = snapshot({ error: rateLimitedError(null), retryAt: new Date(NOW.getTime() + 4 * 60_000 + 20_000) });
    expect(toDisplay(held, NOW, TZ).notice).toEqual({
      level: 'warning',
      code: 'rate_limited',
      message: 'Consultas demais em pouco tempo (429). Mostrando dados de 12:17.',
      hint: 'Próxima consulta liberada às 12:26.',
    });
    // Absolute: a frame drawn later (or the next web poll) says the same thing.
    expect(toDisplay(held, new Date(NOW.getTime() + 3 * 60_000), TZ).notice?.hint).toBe('Próxima consulta liberada às 12:26.');
    // In the viewer's time zone; a hold is at most 1h, so the clock alone is unambiguous past midnight.
    const lateNight = snapshot({ error: rateLimitedError(null), retryAt: new Date('2026-10-08T03:04:10Z') });
    expect(toDisplay(lateNight, new Date('2026-10-08T02:40:00Z'), TZ).notice?.hint).toBe('Próxima consulta liberada às 00:05.');
  });

  it('keeps the error hint when there is no hold to report', () => {
    const failed = snapshot({ error: usageError('network_error', 'Sem conexão com api.anthropic.com.', 'Confira a internet/VPN e tente de novo.') });
    expect(toDisplay(failed, NOW, TZ).notice?.hint).toBe('Confira a internet/VPN e tente de novo.');
  });

  it('turns an error without data into an error notice', () => {
    const display = toDisplay(
      snapshot({
        payload: null,
        fetchedAt: null,
        plan: null,
        tokenExpiresAt: null,
        account: null,
        error: usageError('no_credentials', 'Nenhum login do Claude Code encontrado.', HINTS.login),
      }),
      NOW,
      TZ,
    );
    expect(display).toEqual({
      hasData: false,
      plan: null,
      email: null,
      limits: [],
      breakdown: null,
      credits: null,
      updatedAt: null,
      updatedAgo: null,
      loginStatus: null,
      notice: {
        level: 'error',
        code: 'no_credentials',
        message: 'Nenhum login do Claude Code encontrado.',
        hint: HINTS.login,
      },
    });
  });

  it('says so when the numbers come from a fixture, unless an error has more to say', () => {
    const fixture = toDisplay(snapshot({ credentialsSource: 'fixture' }), NOW, TZ);
    expect(fixture.notice).toMatchObject({ level: 'warning', code: 'fixture', hint: null });
    expect(fixture.notice?.message).toContain('`CLAUDE_USAGE_FIXTURE`');
    const failing = toDisplay(
      snapshot({ credentialsSource: 'fixture', error: usageError('bad_response', 'Fixture com formato inválido.') }),
      NOW,
      TZ,
    );
    expect(failing.notice?.code).toBe('bad_response');
  });

  it('keeps hasData with no limits, so the page shows the notice as a banner and not as "Sem dados"', () => {
    const display = toDisplay(snapshot({ payload: { limits: [] }, credentialsSource: 'fixture' }), NOW, TZ);
    expect(display.hasData).toBe(true);
    expect(display.limits).toHaveLength(0);
    expect(display.notice?.code).toBe('fixture');
  });

  it('reports an expired login', () => {
    const display = toDisplay(snapshot({ tokenExpiresAt: new Date('2026-10-06T23:00:00Z') }), NOW, TZ);
    expect(display.loginStatus).toBe('login expirou ontem 20:00');
  });

  it('summarizes enabled credits', () => {
    const display = toDisplay(
      snapshot({
        payload: {
          spend: {
            enabled: true,
            used: { amount_minor: 1234, currency: 'USD', exponent: 2 },
            limit: { amount_minor: 5000, currency: 'USD', exponent: 2 },
            percent: 24.68,
            severity: 'normal',
          },
        },
      }),
      NOW,
      TZ,
    );
    expect(display.credits?.summary.replace(/\s/g, ' ')).toBe('US$ 12,34 de US$ 50,00');
    expect(display.credits?.percent).toBe(25);
  });
});

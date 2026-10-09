import { describe, expect, it } from 'vitest';
import { buildUsageView, describeLimit, resolveSeverity, scopeNames } from '../src/usage-view.js';
import { loadFixture } from './helpers.js';

describe('buildUsageView — real payload captured 2026-10-07', () => {
  const view = buildUsageView(loadFixture('usage-2026-10-07.json'));

  it('maps limits[] in API order with pt-BR labels', () => {
    expect(view.limits.map((limit) => [limit.label, limit.detail, limit.percent, limit.severity])).toEqual([
      ['Sessão atual', 'janela de 5h', 14, 'normal'],
      ['Semana', 'todos os modelos', 4, 'normal'],
      ['Semana', 'só Fable', 0, 'normal'],
    ]);
    expect(view.limits[0]?.resetsAt?.toISOString()).toBe('2026-10-07T19:50:00.446Z');
    expect(view.limits[2]?.resetsAt?.toISOString()).toBe('2026-10-10T04:00:00.000Z');
  });

  it('skips codename keys (iguana_necktie & co.)', () => {
    expect(view.limits).toHaveLength(3);
  });

  it('maps the weekly breakdown with pt-BR surface names', () => {
    expect(view.breakdown?.since?.toISOString()).toBe('2026-10-03T04:00:00.446Z');
    expect(view.breakdown?.rows).toEqual([
      { key: 'claude_code', label: 'Claude Code', percent: 100 },
      { key: 'chat', label: 'Chat', percent: 0 },
      { key: 'cowork', label: 'Cowork', percent: 0 },
      { key: 'other', label: 'Outros', percent: 0 },
    ]);
  });

  it('maps spend into credits', () => {
    expect(view.credits).toEqual({
      enabled: false,
      used: { amountMinor: 0, currency: 'USD', exponent: 2 },
      limit: null,
      percent: 0,
      severity: 'normal',
    });
  });
});

describe('buildUsageView — legacy payload (no limits[])', () => {
  it('derives limits from the per-window keys', () => {
    const view = buildUsageView({
      five_hour: { utilization: 81.4, resets_at: '2026-10-07T19:50:00+00:00' },
      seven_day: { utilization: 35, resets_at: null },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 96.2 },
      iguana_necktie: { utilization: 99, resets_at: null },
    });
    expect(view.limits.map((limit) => [limit.id, limit.detail, limit.percent, limit.severity])).toEqual([
      ['five_hour', 'janela de 5h', 81, 'warning'],
      ['seven_day', 'todos os modelos', 35, 'normal'],
      ['seven_day_sonnet', 'só Sonnet', 96, 'critical'],
    ]);
    expect(view.limits[1]?.resetsAt).toBeNull();
  });

  it('falls back when limits[] has nothing usable', () => {
    const view = buildUsageView({ limits: [null, { kind: 'session' }], five_hour: { utilization: 10, resets_at: null } });
    expect(view.limits.map((limit) => limit.id)).toEqual(['five_hour']);
  });
});

describe('buildUsageView — robustness', () => {
  it('drops malformed limit items and keeps the valid ones', () => {
    const view = buildUsageView({
      limits: [
        null,
        'session',
        { kind: '' , percent: 5 },
        { kind: 'session', percent: 'x' },
        { kind: 'session', percent: Number.NaN },
        { kind: 'weekly_all', group: 'weekly', percent: 50.5, resets_at: 'not a date' },
      ],
    });
    expect(view.limits).toEqual([
      { id: 'weekly_all-5', label: 'Semana', detail: 'todos os modelos', percent: 51, severity: 'normal', resetsAt: null },
    ]);
  });

  it('keeps a limit whose cosmetic fields changed type', () => {
    const view = buildUsageView({
      limits: [{ kind: 'weekly_all', group: { id: 'weekly' }, percent: 12, severity: 3, resets_at: 1_760_000_000 }],
    });
    expect(view.limits).toEqual([
      { id: 'weekly_all-0', label: 'Semana', detail: 'todos os modelos', percent: 12, severity: 'normal', resetsAt: null },
    ]);
    const legacy = buildUsageView({ five_hour: { utilization: 20, resets_at: 1_760_000_000 } });
    expect(legacy.limits[0]).toMatchObject({ id: 'five_hour', percent: 20, resetsAt: null });
  });

  it('takes severity from the rounded number on screen', () => {
    const view = buildUsageView({
      limits: [
        { kind: 'session', percent: 89.5 },
        { kind: 'weekly_all', percent: 74.5 },
        { kind: 'weekly_scoped', percent: 74.4 },
      ],
    });
    expect(view.limits.map((limit) => [limit.percent, limit.severity])).toEqual([
      [90, 'critical'],
      [75, 'warning'],
      [74, 'normal'],
    ]);
    expect(buildUsageView({ seven_day: { utilization: 89.6 } }).limits[0]).toMatchObject({ percent: 90, severity: 'critical' });
  });

  it('strips terminal controls from API-provided names', () => {
    const view = buildUsageView({
      limits: [
        { kind: 'weekly_scoped', percent: 1, scope: { model: { display_name: 'Op\u001b]52;c;ZXZpbA==\u0007us' } } },
        { kind: 'odd\u001b[2Jkind', percent: 1 },
        { kind: 'weekly_scoped', percent: 1, scope: { model: '\u001b\u0007' } },
      ],
      seven_day_breakdown: { rows: [{ key: 'new_app', display_name: 'App\r\u001b[31mFAKE', percent: 3 }] },
    });
    const texts = [...view.limits.flatMap((limit) => [limit.label, limit.detail]), ...(view.breakdown?.rows ?? []).map((row) => row.label)];
    // eslint-disable-next-line no-control-regex
    for (const text of texts) expect(text ?? '').not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(view.limits.map((limit) => limit.detail)).toEqual(['só Op]52;c;ZXZpbA==us', null, 'escopo restrito']);
    expect(view.limits[1]?.label).toBe('Odd[2Jkind');
    expect(view.breakdown?.rows[0]?.label).toBe('App[31mFAKE');
  });

  it('keeps percentages above 100 and flags them critical', () => {
    const view = buildUsageView({ limits: [{ kind: 'session', percent: 104, severity: 'normal' }] });
    expect(view.limits[0]).toMatchObject({ percent: 104, severity: 'critical' });
  });

  it('returns an empty view for an empty payload', () => {
    expect(buildUsageView({})).toEqual({ limits: [], breakdown: null, credits: null });
  });

  it('drops invalid breakdown rows and empty breakdowns', () => {
    expect(buildUsageView({ seven_day_breakdown: { rows: [] } }).breakdown).toBeNull();
    const view = buildUsageView({
      seven_day_breakdown: { rows: [{ key: 'chat', percent: 'x' }, { key: 'mobile_app', display_name: null, percent: 12.4 }] },
    });
    expect(view.breakdown).toEqual({ since: null, rows: [{ key: 'mobile_app', label: 'Mobile app', percent: 12 }] });
  });

  it('keeps breakdown rows and since when cosmetic fields change type', () => {
    const view = buildUsageView({
      seven_day_breakdown: {
        window_started_at: 1_759_464_000,
        rows: [
          { key: 'claude_code', display_name: { en: 'Claude Code' }, percent: 100 },
          { key: 'new_app', display_name: 7, percent: 3 },
        ],
      },
    });
    expect(view.breakdown).toEqual({
      since: null,
      rows: [
        { key: 'claude_code', label: 'Claude Code', percent: 100 },
        { key: 'new_app', label: 'New app', percent: 3 },
      ],
    });
  });

  it('keeps credit amounts when spend.severity changes type', () => {
    const view = buildUsageView({
      spend: {
        enabled: true,
        used: { amount_minor: 2500, currency: 'USD', exponent: 2 },
        limit: { amount_minor: 5000, currency: 'USD', exponent: 2 },
        percent: 50,
        severity: 1,
      },
    });
    expect(view.credits).toEqual({
      enabled: true,
      used: { amountMinor: 2500, currency: 'USD', exponent: 2 },
      limit: { amountMinor: 5000, currency: 'USD', exponent: 2 },
      percent: 50,
      severity: 'normal',
    });
  });

  it('ignores Object.prototype names as breakdown keys', () => {
    const view = buildUsageView({
      seven_day_breakdown: {
        rows: [
          { key: 'constructor', percent: 5 },
          { key: 'toString', display_name: 'Tools', percent: 3 },
          { key: '__proto__', percent: 0 },
        ],
      },
    });
    expect(view.breakdown?.rows).toEqual([
      { key: 'constructor', label: 'Constructor', percent: 5 },
      { key: 'toString', label: 'Tools', percent: 3 },
      { key: '__proto__', label: 'Proto', percent: 0 },
    ]);
  });

  it('maps enabled credits with money and rounds the percent', () => {
    const view = buildUsageView({
      spend: {
        enabled: true,
        used: { amount_minor: 1234, currency: 'usd', exponent: 2 },
        limit: { amount_minor: 5000, currency: 'USD', exponent: 2 },
        percent: 24.6,
        severity: 'normal',
      },
    });
    expect(view.credits).toEqual({
      enabled: true,
      used: { amountMinor: 1234, currency: 'USD', exponent: 2 },
      limit: { amountMinor: 5000, currency: 'USD', exponent: 2 },
      percent: 25,
      severity: 'normal',
    });
  });

  it('falls back to extra_usage when spend is absent', () => {
    expect(buildUsageView({ extra_usage: { is_enabled: true, utilization: 80 } }).credits).toEqual({
      enabled: true,
      used: null,
      limit: null,
      percent: 80,
      severity: 'warning',
    });
  });
});

describe('resolveSeverity', () => {
  it('escalates by percent but never downgrades what the API says', () => {
    expect(resolveSeverity('normal', 92)).toBe('critical');
    expect(resolveSeverity('normal', 75)).toBe('warning');
    expect(resolveSeverity('critical', 10)).toBe('critical');
    expect(resolveSeverity('WARNING', 0)).toBe('warning');
    expect(resolveSeverity('mystery', 80)).toBe('warning');
    expect(resolveSeverity(null, null)).toBe('normal');
  });
});

describe('describeLimit', () => {
  it('labels known kinds', () => {
    expect(describeLimit('session', 'session', [])).toEqual({ label: 'Sessão atual', detail: 'janela de 5h' });
    expect(describeLimit('weekly_scoped', 'weekly', ['Fable'])).toEqual({ label: 'Semana', detail: 'só Fable' });
  });
  it('labels unknown kinds from group and scope', () => {
    expect(describeLimit('monthly_scoped', 'monthly', ['Opus'])).toEqual({ label: 'Mês', detail: 'só Opus' });
    expect(describeLimit('weekly_surface', 'weekly', [])).toEqual({ label: 'Semana', detail: 'Weekly surface' });
    expect(describeLimit('brand_new', null, [])).toEqual({ label: 'Brand new', detail: null });
  });
});

describe('scopeNames', () => {
  it('reads names from strings or {display_name, id}', () => {
    expect(scopeNames({ model: { id: null, display_name: 'Fable' }, surface: null })).toEqual(['Fable']);
    expect(scopeNames({ model: 'Opus', surface: { id: 'claude_code' } })).toEqual(['Opus', 'claude_code']);
    expect(scopeNames(null)).toEqual([]);
    expect(scopeNames('weird')).toEqual([]);
  });
});

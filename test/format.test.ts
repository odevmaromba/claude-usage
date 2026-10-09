import { describe, expect, it } from 'vitest';
import {
  formatAgo,
  formatClock,
  formatDuration,
  formatMoney,
  formatStamp,
  formatWhen,
  planLabel,
} from '../src/format.js';
import { CAPTURED_AT as NOW, TZ } from './helpers.js';

describe('formatDuration', () => {
  it.each([
    [0, 'menos de 1 min'],
    [59_999, 'menos de 1 min'],
    [-5_000, 'menos de 1 min'],
    [Number.NaN, 'menos de 1 min'],
    [60_000, '1 min'],
    [42 * 60_000 + 59_000, '42 min'],
    [60 * 60_000, '1h'],
    [(4 * 60 + 29) * 60_000 + 13_000, '4h 29min'],
    [24 * 3_600_000, '1d'],
    [(2 * 24 + 12) * 3_600_000 + 39 * 60_000, '2d 12h'],
  ])('%d ms → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('formatWhen', () => {
  it('names today, tomorrow and yesterday; dates further out get weekday + date', () => {
    expect(formatWhen(new Date('2026-10-07T19:50:00.446240+00:00'), NOW, TZ)).toBe('hoje 16:50');
    expect(formatWhen(new Date('2026-10-08T04:00:00Z'), NOW, TZ)).toBe('amanhã 01:00');
    expect(formatWhen(new Date('2026-10-07T02:59:00Z'), NOW, TZ)).toBe('ontem 23:59');
    expect(formatWhen(new Date('2026-10-10T04:00:00Z'), NOW, TZ)).toBe('sáb 10/10 01:00');
    expect(formatWhen(new Date('2026-10-03T04:00:00Z'), NOW, TZ)).toBe('sáb 03/10 01:00');
    expect(formatWhen(new Date('2027-01-01T12:00:00Z'), NOW, TZ)).toBe('sex 01/01 09:00');
  });

  it('uses the local day, not the UTC day', () => {
    expect(formatWhen(new Date('2026-10-08T02:30:00Z'), NOW, TZ)).toBe('hoje 23:30');
    expect(formatWhen(new Date('2026-10-08T02:30:00Z'), NOW, 'UTC')).toBe('amanhã 02:30');
  });

  it('renders midnight as 00:00', () => {
    expect(formatClock(new Date('2026-10-08T03:00:00Z'), TZ)).toBe('00:00');
  });
});

describe('formatStamp', () => {
  it('drops "hoje" but keeps other days', () => {
    expect(formatStamp(new Date('2026-10-07T15:00:00Z'), NOW, TZ)).toBe('12:00');
    expect(formatStamp(new Date('2026-10-06T15:00:00Z'), NOW, TZ)).toBe('ontem 12:00');
  });
});

describe('formatAgo', () => {
  it.each([
    [-1_000, 'agora'],
    [59_000, 'agora'],
    [3 * 60_000, 'há 3 min'],
    [2 * 3_600_000 + 5 * 60_000, 'há 2h'],
    [26 * 3_600_000, 'há 1d'],
  ])('%d ms → %s', (ms, expected) => {
    expect(formatAgo(ms)).toBe(expected);
  });
});

describe('formatMoney', () => {
  it('formats integer minor units as pt-BR currency', () => {
    expect(formatMoney({ amountMinor: 1234, currency: 'USD', exponent: 2 }).replace(/\s/g, ' ')).toBe('US$ 12,34');
    expect(formatMoney({ amountMinor: 0, currency: 'USD', exponent: 2 }).replace(/\s/g, ' ')).toBe('US$ 0,00');
    expect(formatMoney({ amountMinor: 5, currency: 'JPY', exponent: 0 }).replace(/\s/g, ' ')).toBe('JP¥ 5');
  });
});

describe('planLabel', () => {
  it('prefers the multiplier from the rate-limit tier', () => {
    expect(planLabel('max', 'default_claude_max_20x')).toBe('Max 20x');
    expect(planLabel('max', 'default_claude_max_5x')).toBe('Max 5x');
  });
  it('falls back to the subscription type', () => {
    expect(planLabel('pro', 'default_claude_ai')).toBe('Pro');
    expect(planLabel(null, null)).toBeNull();
  });
});

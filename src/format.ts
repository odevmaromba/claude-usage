import { stripControl } from './text.js';
import type { Money } from './usage-view.js';

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'] as const;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  const cached = formatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });
  formatters.set(key, formatter);
  return formatter;
}

function localParts(date: Date, timeZone?: string): LocalParts {
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
  };
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

function dayIndex(parts: LocalParts): number {
  return Math.round(Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS);
}

export function formatClock(date: Date, timeZone?: string): string {
  const parts = localParts(date, timeZone);
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

/** "hoje 16:50", "amanhã 01:00", "ontem 22:10" or "sex 10/10 01:00", in local time. */
export function formatWhen(date: Date, now: Date, timeZone?: string): string {
  const target = localParts(date, timeZone);
  const clock = `${pad2(target.hour)}:${pad2(target.minute)}`;
  const diff = dayIndex(target) - dayIndex(localParts(now, timeZone));
  if (diff === 0) return `hoje ${clock}`;
  if (diff === 1) return `amanhã ${clock}`;
  if (diff === -1) return `ontem ${clock}`;
  const weekday = WEEKDAYS[new Date(Date.UTC(target.year, target.month - 1, target.day)).getUTCDay()] ?? '';
  return `${weekday} ${pad2(target.day)}/${pad2(target.month)} ${clock}`;
}

/** Like formatWhen, but just the clock when it is today. */
export function formatStamp(date: Date, now: Date, timeZone?: string): string {
  const when = formatWhen(date, now, timeZone);
  return when.startsWith('hoje ') ? when.slice('hoje '.length) : when;
}

/** Countdown, floored: "menos de 1 min", "42 min", "4h 29min", "2d 12h". */
export function formatDuration(ms: number): string {
  if (!(ms >= MINUTE_MS)) return 'menos de 1 min';
  const totalMinutes = Math.floor(ms / MINUTE_MS);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}min` : `${hours}h`;
  return `${minutes} min`;
}

export function formatAgo(ms: number): string {
  if (!(ms >= MINUTE_MS)) return 'agora';
  if (ms < HOUR_MS) return `há ${Math.floor(ms / MINUTE_MS)} min`;
  if (ms < DAY_MS) return `há ${Math.floor(ms / HOUR_MS)}h`;
  return `há ${Math.floor(ms / DAY_MS)}d`;
}

export function formatMoney(money: Money): string {
  const amount = money.amountMinor / 10 ** money.exponent;
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: money.currency,
      minimumFractionDigits: money.exponent,
      maximumFractionDigits: money.exponent,
    }).format(amount);
  } catch {
    return `${amount.toFixed(money.exponent)} ${money.currency}`;
  }
}

/** "Max 20x" from `default_claude_max_20x`; else the capitalized subscription type. */
export function planLabel(subscriptionType: string | null, rateLimitTier: string | null): string | null {
  const multiplier = rateLimitTier ? /max_(\d+)x/i.exec(rateLimitTier)?.[1] : undefined;
  if (multiplier) return `Max ${multiplier}x`;
  const clean = subscriptionType ? stripControl(subscriptionType).trim() : '';
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : null;
}

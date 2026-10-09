import { z } from 'zod';
import { stripControl } from './text.js';
import type { UsagePayload } from './usage-api.js';

export type Severity = 'normal' | 'warning' | 'critical';

export interface LimitView {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
  /** Rounded; may exceed 100. */
  readonly percent: number;
  readonly severity: Severity;
  readonly resetsAt: Date | null;
}

export interface BreakdownRowView {
  readonly key: string;
  readonly label: string;
  readonly percent: number;
}

export interface BreakdownView {
  readonly since: Date | null;
  readonly rows: readonly BreakdownRowView[];
}

/** Integer minor units (cents) + ISO currency, as the API sends it. */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
  readonly exponent: number;
}

export interface CreditsView {
  readonly enabled: boolean;
  readonly used: Money | null;
  readonly limit: Money | null;
  readonly percent: number | null;
  readonly severity: Severity;
}

export interface UsageView {
  readonly limits: readonly LimitView[];
  readonly breakdown: BreakdownView | null;
  readonly credits: CreditsView | null;
}

const optionalNumber = z.number().nullish();
const optionalString = z.string().nullish();
/** Cosmetic fields: a type change upstream degrades to null instead of dropping the whole item. */
const lenientString = z.string().nullish().catch(null);

const LimitSchema = z.object({
  kind: z.string().min(1),
  group: lenientString,
  percent: optionalNumber,
  severity: lenientString,
  resets_at: lenientString,
  scope: z.unknown().optional(),
});

const ScopeSchema = z.object({ model: z.unknown().optional(), surface: z.unknown().optional() });
const NamedSchema = z.union([z.string().min(1), z.object({ display_name: optionalString, id: optionalString })]);

const WindowSchema = z.object({ utilization: z.number(), resets_at: lenientString });

const MoneySchema = z.object({
  amount_minor: z.number().int(),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  exponent: z.number().int().min(0).max(6),
});

const SpendSchema = z.object({
  used: z.unknown().optional(),
  limit: z.unknown().optional(),
  percent: optionalNumber,
  severity: optionalString,
  enabled: z.boolean().nullish(),
});

const ExtraUsageSchema = z.object({ is_enabled: z.boolean().nullish(), utilization: optionalNumber });

const BreakdownSchema = z.object({ window_started_at: optionalString, rows: z.array(z.unknown()).nullish() });
const BreakdownRowSchema = z.object({ key: z.string().min(1), display_name: optionalString, percent: z.number() });

/** Pre-`limits` payloads only expose these per-window keys. Codename keys are skipped on purpose. */
const LEGACY_WINDOWS: ReadonlyArray<{ key: string; label: string; detail: string }> = [
  { key: 'five_hour', label: 'Sessão atual', detail: 'janela de 5h' },
  { key: 'seven_day', label: 'Semana', detail: 'todos os modelos' },
  { key: 'seven_day_opus', label: 'Semana', detail: 'só Opus' },
  { key: 'seven_day_sonnet', label: 'Semana', detail: 'só Sonnet' },
  { key: 'seven_day_oauth_apps', label: 'Semana', detail: 'apps conectados' },
  { key: 'seven_day_cowork', label: 'Semana', detail: 'só Cowork' },
];

const SURFACE_LABELS: Readonly<Record<string, string>> = {
  claude_code: 'Claude Code',
  chat: 'Chat',
  cowork: 'Cowork',
  other: 'Outros',
};

const SEVERITY_ALIASES: Readonly<Record<string, Severity>> = {
  normal: 'normal',
  ok: 'normal',
  low: 'normal',
  info: 'normal',
  warning: 'warning',
  warn: 'warning',
  elevated: 'warning',
  approaching: 'warning',
  high: 'warning',
  critical: 'critical',
  exceeded: 'critical',
  limited: 'critical',
  blocked: 'critical',
  error: 'critical',
};

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { normal: 0, warning: 1, critical: 2 };
const WARNING_PERCENT = 75;
const CRITICAL_PERCENT = 90;

/** The more severe of what the API says and what the percentage implies. */
export function resolveSeverity(raw: string | null | undefined, percent: number | null): Severity {
  const fromApi = (raw ? SEVERITY_ALIASES[raw.toLowerCase()] : undefined) ?? 'normal';
  const fromPercent: Severity =
    percent === null ? 'normal' : percent >= CRITICAL_PERCENT ? 'critical' : percent >= WARNING_PERCENT ? 'warning' : 'normal';
  return SEVERITY_RANK[fromApi] >= SEVERITY_RANK[fromPercent] ? fromApi : fromPercent;
}

export function buildUsageView(payload: UsagePayload): UsageView {
  return {
    limits: buildLimits(payload),
    breakdown: buildBreakdown(payload.seven_day_breakdown),
    credits: buildCredits(payload.spend, payload.extra_usage),
  };
}

function buildLimits(payload: UsagePayload): LimitView[] {
  const list = z.array(z.unknown()).safeParse(payload.limits);
  const fromLimits = list.success ? list.data.flatMap((item, index) => toLimitView(item, index)) : [];
  return fromLimits.length > 0 ? fromLimits : legacyLimits(payload);
}

function toLimitView(item: unknown, index: number): LimitView[] {
  const parsed = LimitSchema.safeParse(item);
  if (!parsed.success) return [];
  const { kind, group, percent, severity, resets_at: resetsAt, scope } = parsed.data;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return [];
  const { label, detail } = describeLimit(kind, group ?? null, scopeNames(scope));
  // Severity follows the number on screen: 89.5 shows as 90% and must look like 90%.
  const rounded = Math.round(percent);
  return [
    {
      id: `${kind}-${index}`,
      label,
      detail,
      percent: rounded,
      severity: resolveSeverity(severity, rounded),
      resetsAt: parseDate(resetsAt),
    },
  ];
}

function legacyLimits(payload: UsagePayload): LimitView[] {
  return LEGACY_WINDOWS.flatMap(({ key, label, detail }) => {
    const parsed = WindowSchema.safeParse(payload[key]);
    if (!parsed.success || !Number.isFinite(parsed.data.utilization)) return [];
    const percent = Math.round(parsed.data.utilization);
    return [
      {
        id: key,
        label,
        detail,
        percent,
        severity: resolveSeverity(null, percent),
        resetsAt: parseDate(parsed.data.resets_at),
      },
    ];
  });
}

export function describeLimit(
  kind: string,
  group: string | null,
  names: readonly string[],
): { label: string; detail: string | null } {
  const only = names.length > 0 ? `só ${names.join(' + ')}` : null;
  if (kind === 'session') return { label: 'Sessão atual', detail: only ?? 'janela de 5h' };
  if (kind === 'weekly_all') return { label: 'Semana', detail: 'todos os modelos' };
  if (kind === 'weekly_scoped') return { label: 'Semana', detail: only ?? 'escopo restrito' };
  const base = group === 'session' ? 'Sessão' : group === 'weekly' ? 'Semana' : group === 'monthly' ? 'Mês' : null;
  if (base) return { label: base, detail: only ?? humanize(kind) };
  return { label: humanize(kind), detail: only };
}

/** Model/surface names from `scope`; tolerant to string or `{display_name, id}` shapes. */
export function scopeNames(scope: unknown): string[] {
  const parsed = ScopeSchema.safeParse(scope);
  if (!parsed.success) return [];
  const names: string[] = [];
  for (const value of [parsed.data.model, parsed.data.surface]) {
    const named = NamedSchema.safeParse(value);
    if (!named.success) continue;
    const raw = typeof named.data === 'string' ? named.data : (named.data.display_name ?? named.data.id ?? null);
    const name = raw ? stripControl(raw).trim() : '';
    if (name) names.push(name);
  }
  return names;
}

function buildBreakdown(value: unknown): BreakdownView | null {
  const parsed = BreakdownSchema.safeParse(value);
  if (!parsed.success || !parsed.data.rows) return null;
  const rows = parsed.data.rows.flatMap((row): BreakdownRowView[] => {
    const item = BreakdownRowSchema.safeParse(row);
    if (!item.success || !Number.isFinite(item.data.percent)) return [];
    const { key, display_name: displayName, percent } = item.data;
    const label = SURFACE_LABELS[key] ?? (displayName ? stripControl(displayName).trim() : '');
    return [{ key, label: label || humanize(key), percent: Math.round(percent) }];
  });
  return rows.length > 0 ? { since: parseDate(parsed.data.window_started_at), rows } : null;
}

function buildCredits(spend: unknown, extraUsage: unknown): CreditsView | null {
  const parsedSpend = SpendSchema.safeParse(spend);
  if (parsedSpend.success) {
    const { used, limit, percent, severity, enabled } = parsedSpend.data;
    const rounded = typeof percent === 'number' && Number.isFinite(percent) ? Math.round(percent) : null;
    return {
      enabled: enabled === true,
      used: toMoney(used),
      limit: toMoney(limit),
      percent: rounded,
      severity: resolveSeverity(severity, rounded),
    };
  }
  const parsedExtra = ExtraUsageSchema.safeParse(extraUsage);
  if (parsedExtra.success) {
    const { is_enabled: enabled, utilization } = parsedExtra.data;
    const rounded = typeof utilization === 'number' && Number.isFinite(utilization) ? Math.round(utilization) : null;
    return { enabled: enabled === true, used: null, limit: null, percent: rounded, severity: resolveSeverity(null, rounded) };
  }
  return null;
}

function toMoney(value: unknown): Money | null {
  const parsed = MoneySchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    amountMinor: parsed.data.amount_minor,
    currency: parsed.data.currency.toUpperCase(),
    exponent: parsed.data.exponent,
  };
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

function humanize(key: string): string {
  const words = stripControl(key).replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '?';
}

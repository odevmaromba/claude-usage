import type { UsageErrorCode } from './errors.js';
import { formatAgo, formatDuration, formatMoney, formatStamp, formatWhen } from './format.js';
import type { Snapshot } from './usage-source.js';
import { buildUsageView, type CreditsView, type LimitView, type Severity } from './usage-view.js';

/** Everything a screen needs, already formatted (pt-BR, local time). Plain JSON: the web page gets it as is. */
export interface Display {
  readonly hasData: boolean;
  readonly plan: string | null;
  readonly email: string | null;
  readonly limits: readonly DisplayLimit[];
  readonly breakdown: DisplayBreakdown | null;
  readonly credits: DisplayCredits | null;
  readonly updatedAt: string | null;
  readonly updatedAgo: string | null;
  readonly loginStatus: string | null;
  readonly notice: DisplayNotice | null;
}

export interface DisplayLimit {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
  readonly percent: number;
  readonly severity: Severity;
  /** "4h 29min"; null when unknown or already passed. */
  readonly resetIn: string | null;
  /** "hoje 16:50". */
  readonly resetAt: string | null;
  /** Reset time is in the past: the number is from before the reset. */
  readonly resetPassed: boolean;
}

export interface DisplayBreakdown {
  readonly since: string | null;
  readonly rows: ReadonlyArray<{ readonly key: string; readonly label: string; readonly percent: number }>;
}

export interface DisplayCredits {
  readonly enabled: boolean;
  readonly summary: string;
  readonly percent: number | null;
  readonly severity: Severity;
}

export interface DisplayNotice {
  readonly level: 'warning' | 'error';
  readonly code: UsageErrorCode | 'fixture';
  readonly message: string;
  readonly hint: string | null;
}

const MINUTE_MS = 60_000;

/** Reset times come jittered by under a second around the minute they mean (19:49:59.83 = 19:50). */
function nearestMinute(date: Date): Date {
  return new Date(Math.round(date.getTime() / MINUTE_MS) * MINUTE_MS);
}

export function toDisplay(snapshot: Snapshot, now: Date, timeZone?: string): Display {
  const view = snapshot.payload ? buildUsageView(snapshot.payload) : null;
  const updatedAt = snapshot.fetchedAt ? formatStamp(snapshot.fetchedAt, now, timeZone) : null;
  return {
    hasData: view !== null,
    plan: snapshot.plan,
    email: snapshot.account?.email ?? null,
    limits: (view?.limits ?? []).map((limit) => toDisplayLimit(limit, now, timeZone)),
    breakdown: view?.breakdown
      ? {
          since: view.breakdown.since ? formatWhen(nearestMinute(view.breakdown.since), now, timeZone) : null,
          rows: view.breakdown.rows.map(({ key, label, percent }) => ({ key, label, percent })),
        }
      : null,
    credits: view?.credits ? toDisplayCredits(view.credits) : null,
    updatedAt,
    updatedAgo: snapshot.fetchedAt ? formatAgo(now.getTime() - snapshot.fetchedAt.getTime()) : null,
    loginStatus: loginStatus(snapshot.tokenExpiresAt, now, timeZone),
    notice: snapshot.error
      ? {
          level: view ? 'warning' : 'error',
          code: snapshot.error.code,
          message: view && updatedAt ? `${snapshot.error.message} Mostrando dados de ${updatedAt}.` : snapshot.error.message,
          hint: snapshot.error.hint,
        }
      : snapshot.credentialsSource === 'fixture'
        ? FIXTURE_NOTICE
        : null,
  };
}

const FIXTURE_NOTICE: DisplayNotice = {
  level: 'warning',
  code: 'fixture',
  message: 'Dados de fixture (`CLAUDE_USAGE_FIXTURE`), não da sua conta.',
  hint: null,
};

function toDisplayLimit(limit: LimitView, now: Date, timeZone?: string): DisplayLimit {
  const resetsAt = limit.resetsAt ? nearestMinute(limit.resetsAt) : null;
  const remaining = resetsAt ? resetsAt.getTime() - now.getTime() : null;
  return {
    id: limit.id,
    label: limit.label,
    detail: limit.detail,
    percent: limit.percent,
    severity: limit.severity,
    resetIn: remaining !== null && remaining > 0 ? formatDuration(remaining) : null,
    resetAt: resetsAt ? formatWhen(resetsAt, now, timeZone) : null,
    resetPassed: remaining !== null && remaining <= 0,
  };
}

function toDisplayCredits(credits: CreditsView): DisplayCredits {
  let summary = 'desativados';
  if (credits.enabled) {
    if (credits.used && credits.limit) summary = `${formatMoney(credits.used)} de ${formatMoney(credits.limit)}`;
    else if (credits.used) summary = `${formatMoney(credits.used)} usados`;
    else summary = 'ativados';
  }
  return { enabled: credits.enabled, summary, percent: credits.enabled ? credits.percent : null, severity: credits.severity };
}

function loginStatus(expiresAt: Date | null, now: Date, timeZone?: string): string | null {
  if (!expiresAt) return null;
  const when = formatWhen(expiresAt, now, timeZone);
  return expiresAt.getTime() > now.getTime() ? `login até ${when}` : `login expirou ${when}`;
}

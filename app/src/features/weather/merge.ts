// OWNER: parcel-detail — collapse advisory noise into farmer-readable weather events
// (docs/UX-REVAMP.md). The backend emits ONE advisory per day, so a four-day heat wave
// renders as four near-identical cards with ISO dates in the prose. This module merges
// runs of the SAME kind on CONSECUTIVE days into a single event with a from/to range and
// the peak value, and provides the plain-language i18n copy for both surfaces
// (WeatherPanel + the weather screen). Pure module: no React, no fetching.
import type { Advisory, Severity } from '@/api/types';
import { formatDay, formatNumber } from '@/lib/format';

const DAY_MS = 86_400_000;

const SEVERITY_RANK: Record<string, number> = { critical: 2, warning: 1, info: 0 };

/** Kinds whose consecutive days read as one event ("Ondata di caldo da … a …"). Unknown
 * kinds are never merged — they pass through untouched, one card per advisory. */
const MERGEABLE_KINDS = new Set(['heat_stress', 'frost_risk', 'spray_window']);

/** First temperature in the message, e.g. "massima 36.0°C" / "low of -2.5°C" → 36 / −2.5.
 * The API advisory carries no numeric field, so the localized message is all we have. */
const TEMP_RE = /(-?\d+(?:[.,]\d+)?)\s*°\s*C/;

export interface AdvisoryRun {
  kind: string;
  /** Worst severity across the run (critical > warning > info). */
  severity: Severity;
  /** ISO date of the first day of the run. */
  from: string;
  /** ISO date of the last day of the run (equals `from` for singles). */
  to: string;
  /** Length of the run in days; 1 = a single advisory passed through untouched. */
  days: number;
  /** Peak temperature parsed from the messages (max for heat, min for frost); null when
   * nothing could be parsed (e.g. spray windows, copy changes upstream). */
  peakValue: number | null;
  /** Localized peak like "36,5 °C" — present only when `peakValue` parsed. */
  peakLabel?: string;
  /** Source advisories, chronological — singles keep their original untouched. */
  advisories: Advisory[];
}

function parseTempC(message: unknown): number | null {
  if (typeof message !== 'string') return null;
  const m = TEMP_RE.exec(message);
  if (!m) return null;
  const n = Number.parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Defensive day index of an ISO `YYYY-MM-DD` date; null when unparseable. */
function dayIndex(date: unknown): number | null {
  if (typeof date !== 'string') return null;
  const t = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? Math.round(t / DAY_MS) : null;
}

function worstSeverity(advisories: Advisory[]): Severity {
  let worst: Severity = advisories[0]?.severity ?? 'info';
  for (const a of advisories) {
    if ((SEVERITY_RANK[a.severity] ?? 0) > (SEVERITY_RANK[worst] ?? 0)) worst = a.severity;
  }
  return worst;
}

function buildRun(kind: string, advisories: Advisory[], firstIdx: number, lastIdx: number): AdvisoryRun {
  // Peak = the extreme that matters for the kind: lowest low for frost, highest high otherwise.
  let peak: number | null = null;
  for (const a of advisories) {
    const v = parseTempC(a.message);
    if (v == null) continue;
    if (peak == null) peak = v;
    else peak = kind === 'frost_risk' ? Math.min(peak, v) : Math.max(peak, v);
  }
  return {
    kind,
    severity: worstSeverity(advisories),
    from: advisories[0].date,
    to: advisories[advisories.length - 1].date,
    days: Math.max(1, lastIdx - firstIdx + 1),
    peakValue: peak,
    peakLabel: peak != null ? `${formatNumber(peak, { maximumFractionDigits: 1 })} °C` : undefined,
    advisories,
  };
}

/**
 * Collapse runs of the SAME kind on CONSECUTIVE days into one event; singles (and any
 * advisory with an unparseable date or an unknown kind) pass through as `days: 1` runs
 * with their original advisory intact. Output is chronological by `from`.
 */
export function mergeAdvisoryRuns(advisories: Advisory[] | null | undefined): AdvisoryRun[] {
  const list = (advisories ?? []).filter((a): a is Advisory => a != null && typeof a.kind === 'string');
  const runs: AdvisoryRun[] = [];

  // Bucket by kind, keeping (dayIdx, advisory); undated advisories become singles right away.
  const byKind = new Map<string, { idx: number; advisory: Advisory }[]>();
  for (const a of list) {
    const idx = dayIndex(a.date);
    if (idx == null || !MERGEABLE_KINDS.has(a.kind)) {
      runs.push(buildRun(a.kind, [a], 0, 0));
      continue;
    }
    const bucket = byKind.get(a.kind);
    if (bucket) bucket.push({ idx, advisory: a });
    else byKind.set(a.kind, [{ idx, advisory: a }]);
  }

  for (const [kind, entries] of byKind) {
    entries.sort((a, b) => a.idx - b.idx);
    let group: Advisory[] = [];
    let firstIdx = 0;
    let lastIdx = 0;
    for (const e of entries) {
      if (group.length === 0) {
        group = [e.advisory];
        firstIdx = e.idx;
        lastIdx = e.idx;
      } else if (e.idx === lastIdx || e.idx === lastIdx + 1) {
        // same-day duplicates are absorbed; the next day extends the run
        group.push(e.advisory);
        lastIdx = e.idx;
      } else {
        runs.push(buildRun(kind, group, firstIdx, lastIdx));
        group = [e.advisory];
        firstIdx = e.idx;
        lastIdx = e.idx;
      }
    }
    if (group.length > 0) runs.push(buildRun(kind, group, firstIdx, lastIdx));
  }

  return runs.sort((a, b) => a.from.localeCompare(b.from) || a.kind.localeCompare(b.kind));
}

const ISO_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/g;

/** Replace raw ISO dates inside prose with localized days ("2026-08-04" → "martedì 4 agosto").
 * Backend messages carry ISO dates; ISO must never reach the farmer (docs/DESIGN.md §14). */
export function humanizeIsoDates(text: string, fmt: (iso: string) => string = formatDay): string {
  return text.replace(ISO_DATE_RE, (match) => {
    const pretty = fmt(match);
    return pretty === '—' ? match : pretty;
  });
}

export interface AdvisoryCopy {
  /** Plain-language title key, null for unknown kinds (render the body only). */
  titleKey: string | null;
  titleParams: Record<string, unknown>;
  /** Advice body key, null when the copy needs a value we could not parse. */
  bodyKey: string | null;
  bodyParams: Record<string, unknown>;
  /** Localized fallback: the original message with ISO dates humanized. */
  fallbackBody: string;
}

/**
 * i18n copy for a merged run: title + body keys with pre-localized params (days via
 * `formatDay`, temperatures via `formatNumber`). Consumers render
 * `t(titleKey, titleParams)` and `bodyKey ? t(bodyKey, bodyParams) : fallbackBody`.
 * Invented keys carry `defaultValue` in the params bag (i18n pending-file protocol).
 */
export function advisoryCopy(run: AdvisoryRun): AdvisoryCopy {
  const single = run.days === 1;
  const fallbackBody = humanizeIsoDates(
    typeof run.advisories[0]?.message === 'string' ? run.advisories[0].message : '',
  );
  const peak =
    run.peakValue != null ? formatNumber(run.peakValue, { maximumFractionDigits: 1 }) : null;
  const from = formatDay(run.from);
  const to = formatDay(run.to);

  if (run.kind === 'heat_stress') {
    return {
      titleKey: single ? 'weather_human.heatwave_single' : 'weather_human.heatwave_title',
      titleParams: single ? { day: from } : { from, to },
      bodyKey: peak != null ? 'weather_human.heatwave_body' : null,
      bodyParams: { max: peak },
      fallbackBody,
    };
  }
  if (run.kind === 'frost_risk') {
    return {
      titleKey: single ? 'weather_human.frost_single' : 'weather_human.frost_title',
      titleParams: single ? { day: from } : { from, to },
      bodyKey: peak != null ? 'weather_human.frost_body' : null,
      bodyParams: { min: peak },
      fallbackBody,
    };
  }
  if (run.kind === 'spray_window') {
    return {
      titleKey: single ? 'weather_human.window_single' : 'weather_human.window_title',
      titleParams: single
        ? { day: from, defaultValue: 'Giornata adatta ai trattamenti {{day}}' }
        : { from, to, defaultValue: 'Giorni adatti ai trattamenti da {{from}} a {{to}}' },
      bodyKey: 'weather_human.window_body',
      bodyParams: {
        defaultValue: 'Vento debole e niente pioggia: buone condizioni per trattamenti e lavori in campo.',
      },
      fallbackBody,
    };
  }
  return { titleKey: null, titleParams: {}, bodyKey: null, bodyParams: {}, fallbackBody };
}

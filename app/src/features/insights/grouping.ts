// OWNER: alert-grouping — collapse per-plant alert noise into agronomic events
// (docs/UX-REVAMP.md §Frozen module contracts). The detector writes one alert per plant;
// a farmer reads ONE event per kind + parcel + day ("Calo di vigore su 12 piante"), with
// plant ids and index values demoted into `techDetail` behind the "Dettagli tecnici"
// disclosure. Pure module: no React, no fetching.
import type { Alert } from '@/api/types';
import { formatNumber } from '@/lib/format';

export interface AlertEvent {
  key: string;
  kind: string;
  severity: string;
  parcelId: string | null;
  /**
   * What the farmer counts: distinct PLANTS for per-plant kinds (the seed can emit two
   * signals for the same plant on one day — "18 segnali" must not read "18 piante"),
   * otherwise the number of alerts. The raw signals stay available in `alerts`.
   */
  count: number;
  latestAt: string;
  alerts: Alert[];
  titleKey: string;
  titleParams: Record<string, unknown>;
  bodyKey: string;
  bodyParams: Record<string, unknown>;
  /** compact mono summary, e.g. "NDVI 0,41 · −23% · R12-P14, R08-P20, +9" — null when nothing parsed */
  techDetail: string | null;
}

const SEVERITY_RANK: Record<string, number> = { critical: 2, warning: 1, info: 0 };

/** Kinds that mean "a single plant lost vigor" — merged into one plain-language vigor event. */
const VIGOR_KINDS = new Set(['plant_drop', 'plant_vigor_outlier']);

/** listed plant refs are capped; the rest becomes "+N" */
const MAX_LISTED_REFS = 8;
const MINUS = '−';

/** Group identity: kind + parcel + calendar day of created_at (UTC day of the ISO stamp). */
function eventKey(a: Alert): string {
  const day = typeof a.created_at === 'string' ? a.created_at.slice(0, 10) : '';
  return `${a.kind}|${a.parcel_id ?? '-'}|${day}`;
}

// ── defensive parsing of the seeded alert copy ───────────────────────────────
// Structured `data` wins (detectors write value/drop_pct/metric there); the message
// text is only a fallback. Every miss is tolerated — a segment simply drops out.

const METRIC_RE = /\b(NDVI|NDRE|GNDVI|NDMI|SAVI)\b/i;
// first decimal number after the metric name: "NDVI sceso a 0.41", "NDVI 0.41 contro 0.53"
const VALUE_RE = /(?:NDVI|NDRE|GNDVI|NDMI|SAVI)\D{0,24}?(-?\d+[.,]\d+)/i;
// "(−23%)" — the backend emits U+2212, tolerate an ASCII hyphen too
const PCT_RE = /\(\s*[−-]\s*(\d+(?:[.,]\d+)?)\s*%\s*\)/;
// plant alerts lead with the plant name: "R12-P14: NDVI sceso a …"
const REF_RE = /^([^:\n]{1,40}):\s/;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseNum(text: string | undefined): number | null {
  if (!text) return null;
  const n = Number.parseFloat(text.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

interface ParsedAlert {
  metric: string | null;
  value: number | null;
  dropPct: number | null;
  ref: string | null;
  /** what identifies the plant this signal is about (plant_id → parsed ref → alert id) */
  plantIdentity: string;
}

function parseAlert(a: Alert): ParsedAlert {
  const data = (a.data ?? {}) as Record<string, unknown>;
  const message = typeof a.message === 'string' ? a.message : '';

  const metricRaw = data.metric ?? data.index;
  const metric =
    typeof metricRaw === 'string' && metricRaw
      ? metricRaw.toUpperCase()
      : (METRIC_RE.exec(message)?.[1]?.toUpperCase() ?? null);

  const value = num(data.value) ?? parseNum(VALUE_RE.exec(message)?.[1]);

  const dropFraction = num(data.drop_pct);
  const dropPct =
    dropFraction != null ? Math.round(dropFraction * 100) : parseNum(PCT_RE.exec(message)?.[1]);

  const ref = a.kind.startsWith('plant') ? (REF_RE.exec(message)?.[1]?.trim() ?? null) : null;

  return { metric, value, dropPct, ref, plantIdentity: a.plant_id ?? ref ?? a.id };
}

/** "NDVI 0,41 · −23% · R12-P14, R08-P20, +9" — or null when nothing could be extracted. */
function buildTechDetail(parsed: ParsedAlert[]): string | null {
  let metric: string | null = null;
  let worstValue: number | null = null;
  let worstDrop: number | null = null;
  const refs: string[] = [];
  const seen = new Set<string>();

  for (const p of parsed) {
    if (p.metric && !metric) metric = p.metric;
    if (p.value != null && (worstValue == null || p.value < worstValue)) worstValue = p.value;
    if (p.dropPct != null && (worstDrop == null || p.dropPct > worstDrop)) worstDrop = p.dropPct;
    if (p.ref && !seen.has(p.ref)) {
      seen.add(p.ref);
      refs.push(p.ref);
    }
  }

  const segments: string[] = [];
  if (metric && worstValue != null) {
    segments.push(
      `${metric} ${formatNumber(worstValue, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );
  }
  if (worstDrop != null) {
    segments.push(`${MINUS}${formatNumber(worstDrop, { maximumFractionDigits: 0 })}%`);
  }
  if (refs.length > 0) {
    const listed = refs.slice(0, MAX_LISTED_REFS);
    const rest = refs.length - listed.length;
    segments.push(rest > 0 ? `${listed.join(', ')}, +${rest}` : listed.join(', '));
  }

  return segments.length > 0 ? segments.join(' · ') : null;
}

// ── grouping ─────────────────────────────────────────────────────────────────

/**
 * Group raw alerts into farmer-facing events. `parcelName` resolves ids for the
 * plain-language title ("… — Uliveto Vecchio"); when omitted the param is ''.
 * Events sort by severity (critical first), then most recent activity.
 */
export function groupAlerts(
  alerts: Alert[],
  parcelName?: (id: string | null) => string,
): AlertEvent[] {
  const groups = new Map<string, Alert[]>();
  for (const a of alerts) {
    const key = eventKey(a);
    const list = groups.get(key);
    if (list) list.push(a);
    else groups.set(key, [a]);
  }

  const events: AlertEvent[] = [];
  for (const [key, group] of groups) {
    const first = group[0];
    let severity: string = first.severity;
    let latestAt = first.created_at;
    for (const a of group) {
      if ((SEVERITY_RANK[a.severity] ?? 0) > (SEVERITY_RANK[severity] ?? 0)) severity = a.severity;
      if (a.created_at > latestAt) latestAt = a.created_at;
    }

    const parsed = group.map(parseAlert);
    const perPlant = first.kind.startsWith('plant');
    // per-plant events count PLANTS (the same plant can signal twice in a day), others count alerts
    const count = perPlant ? new Set(parsed.map((p) => p.plantIdentity)).size : group.length;
    const parcel = parcelName?.(first.parcel_id) ?? '';
    const vigor = VIGOR_KINDS.has(first.kind);

    // i18next resolves _one/_other from `count`; keys are the §Copy spec contract.
    const titleKey = vigor ? 'alerts_group.title_vigor' : 'alerts_group.title_generic';
    const titleParams: Record<string, unknown> = { count, parcel };

    let bodyKey: string;
    let bodyParams: Record<string, unknown>;
    if (vigor) {
      bodyKey = 'alerts_group.body_vigor';
      bodyParams = { count, parcel };
    } else if (group.length === 1) {
      // single generic alert: its own message IS the plain body. The defaultValue rides in
      // the params bag so the copy renders even before the pending key is merged.
      bodyKey = 'alerts_group.body_single';
      bodyParams = { message: first.message, defaultValue: '{{message}}' };
    } else {
      bodyKey = 'alerts_group.body_generic';
      bodyParams = {
        count: group.length,
        parcel,
        defaultValue:
          "{{count}} segnalazioni dello stesso tipo nello stesso giorno. L'elenco completo è nei dettagli tecnici.",
      };
    }

    events.push({
      key,
      kind: first.kind,
      severity,
      parcelId: first.parcel_id,
      count,
      latestAt,
      alerts: group,
      titleKey,
      titleParams,
      bodyKey,
      bodyParams,
      techDetail: buildTechDetail(parsed),
    });
  }

  return events.sort((a, b) => {
    const bySeverity = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    if (bySeverity !== 0) return bySeverity;
    return a.latestAt < b.latestAt ? 1 : a.latestAt > b.latestAt ? -1 : 0;
  });
}

/** Number of grouped events — what the tab badge shows instead of the raw alert count. */
export function countAlertEvents(alerts: Alert[]): number {
  const keys = new Set<string>();
  for (const a of alerts) keys.add(eventKey(a));
  return keys.size;
}

// OWNER: status-pipeline — the single source of truth for field status, trend and headline
// semantics. Frozen contract: docs/UX-REVAMP.md §Frozen module contracts.
//
// Why this exists: the dashboard used to derive its trend from a 7-day series delta while the
// parcel detail used the last two points, and the status chip (open alerts) disagreed with the
// headline (score bands). Same field, two stories. Every screen now derives chip + headline +
// trend from `trendFromSeries` + `deriveFieldStatus` — nothing else.

const DAY_MS = 86_400_000;

/** Movement threshold on the NDVI scale: |delta| ≤ 0.025 reads as "stable" (kept from format.ts). */
const TREND_EPSILON = 0.025;

export type TrendDirection = 'up' | 'flat' | 'down';

export interface FieldTrend {
  /** Latest value minus the baseline value; null when the series has no usable baseline. */
  delta: number | null;
  direction: TrendDirection;
  /** i18n key: status.trend_up | status.trend_flat | status.trend_down. */
  labelKey: string;
}

const TREND_LABEL: Record<TrendDirection, string> = {
  up: 'status.trend_up',
  flat: 'status.trend_flat',
  down: 'status.trend_down',
};

/**
 * Trend of a sparse index series: the latest non-null value compared to the closest non-null
 * value at least `windowDays` older (default 7). Without such a baseline (short or gappy
 * history) there is no trend to tell: `{ delta: null, direction: 'flat', labelKey:
 * 'status.trend_flat' }` — never an alarming guess.
 *
 * Consistency rule: ALL screens must use this (and `deriveFieldStatus`) for trend copy and
 * icons — do not derive trend locally from series deltas. One field, one story everywhere.
 */
export function trendFromSeries(
  points: { date: string; value: number | null }[],
  windowDays = 7,
): FieldTrend {
  // Keep only parseable, non-null samples; sort ascending so caller order never matters.
  const usable = points
    .map((p) => ({ t: Date.parse(p.date), value: p.value }))
    .filter(
      (p): p is { t: number; value: number } =>
        Number.isFinite(p.t) && p.value != null && Number.isFinite(p.value),
    )
    .sort((a, b) => a.t - b.t);

  const latest = usable[usable.length - 1];
  if (!latest) return { delta: null, direction: 'flat', labelKey: TREND_LABEL.flat };

  // Baseline = the most recent point that is ≥ windowDays older than the latest one,
  // i.e. the non-null point closest to the window boundary.
  const cutoff = latest.t - windowDays * DAY_MS;
  let baseline: { t: number; value: number } | undefined;
  for (let i = usable.length - 2; i >= 0; i--) {
    if (usable[i].t <= cutoff) {
      baseline = usable[i];
      break;
    }
  }
  if (!baseline) return { delta: null, direction: 'flat', labelKey: TREND_LABEL.flat };

  const delta = latest.value - baseline.value;
  const direction: TrendDirection =
    delta > TREND_EPSILON ? 'up' : delta < -TREND_EPSILON ? 'down' : 'flat';
  return { delta, direction, labelKey: TREND_LABEL[direction] };
}

export type StatusLevel = 'ok' | 'watch' | 'attention';

export interface FieldStatus {
  level: StatusLevel;
  /** i18n key: status.chip_ok | status.chip_watch | status.chip_attention. */
  chipKey: string;
  /** i18n key: status.headline_{ok|watch|attention}, or status.headline_pending (no score yet). */
  headlineKey: string;
  /** True when the estimate rests on fewer than 3 of the 5 signals — show status.partial. */
  partial: boolean;
}

const CHIP_KEY: Record<StatusLevel, string> = {
  ok: 'status.chip_ok',
  watch: 'status.chip_watch',
  attention: 'status.chip_attention',
};

const HEADLINE_KEY: Record<StatusLevel, string> = {
  ok: 'status.headline_ok',
  watch: 'status.headline_watch',
  attention: 'status.headline_attention',
};

/**
 * One verdict per field, from score + trend + open alert events (grouped, per grouping.ts):
 *
 * - `score == null` → level 'watch' with `status.headline_pending` (first pass still pending;
 *   calm copy, never alarming); `partial` is true when coverage is unknown or < 3.
 * - Score bands: ≥ 75 'ok' · 50–74 'watch' · < 50 'attention'.
 * - `openAlertEvents > 0` forces AT LEAST 'watch' — an open alert must never coexist with an
 *   "all good" headline; combined with score < 60 or a 'down' trend it escalates to 'attention'.
 * - `partial` is true when `coverage != null && coverage < 3` (coverage = signals used, 0–5;
 *   see `arvoScoreDetail` in format.ts).
 *
 * Consistency rule: ALL screens must derive chip + headline from this function (and trend from
 * `trendFromSeries`) — do not derive status locally from severities, score bands or deltas.
 */
export function deriveFieldStatus(i: {
  score: number | null;
  trend: FieldTrend | null;
  openAlertEvents: number;
  coverage?: number | null;
}): FieldStatus {
  const coverage = i.coverage ?? null;

  if (i.score == null) {
    return {
      level: 'watch',
      chipKey: CHIP_KEY.watch,
      headlineKey: 'status.headline_pending',
      partial: coverage == null || coverage < 3,
    };
  }

  let level: StatusLevel = i.score >= 75 ? 'ok' : i.score >= 50 ? 'watch' : 'attention';

  if (i.openAlertEvents > 0) {
    if (level === 'ok') level = 'watch';
    if (i.score < 60 || i.trend?.direction === 'down') level = 'attention';
  }

  return {
    level,
    chipKey: CHIP_KEY[level],
    headlineKey: HEADLINE_KEY[level],
    partial: coverage != null && coverage < 3,
  };
}

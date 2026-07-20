// OWNER: fe-plant-map — pure presentation helpers over the ranking / outlier / replant payloads:
// display names, value + unit formatting, weakest-N slicing, vs-block deltas. No fetching here
// (that's ./hooks), no JSX. Thresholds mirror docs/API-PLANT.md §Plant insights so the app never
// disagrees with the server about what "critical" means.
import type { Plant, PlantMetric, PlantOutlier, PlantRanking, Severity } from '@/api/types';

/** Metrics whose value is a physical quantity, not a 0..1 index — formatted with a unit. */
export const PHYSICAL_METRICS: PlantMetric[] = ['canopy_m2', 'height_m'];

/** i18n key for a metric's short name (`plant.metric.<m>`). */
export function metricLabelKey(metric: PlantMetric): string {
  return `plant.metric.${metric}`;
}

/** i18n key for a metric's unit (`plant.metric_unit.<m>`), null for the unitless indices. */
export function metricUnitKey(metric: PlantMetric): string | null {
  return PHYSICAL_METRICS.includes(metric) ? `plant.metric_unit.${metric}` : null;
}

/** Index values live in 0..1 and need 3 decimals to separate plants; sizes need far fewer. */
const DECIMALS: Record<PlantMetric, number> = {
  ndvi: 3,
  ndre: 3,
  gndvi: 3,
  ndmi: 3,
  savi: 3,
  canopy_m2: 1,
  height_m: 2,
};

/** Metric value as the mono data voice renders it. Unit (if any) is appended by the caller. */
export function formatMetricValue(
  metric: PlantMetric,
  value: number | null | undefined,
  fallback = '—',
): string {
  if (value == null || Number.isNaN(value)) return fallback;
  return value.toFixed(DECIMALS[metric]);
}

/** Human name for a plant: its label, else its grid position, else a translated fallback. */
export function plantName(
  plant: Pick<Plant, 'label' | 'row_index' | 'col_index'> | PlantRanking,
  fallback: string,
): string {
  if (plant.label) return plant.label;
  const row = 'row_index' in plant ? plant.row_index : null;
  const col = 'col_index' in plant ? plant.col_index : null;
  if (row != null && col != null) return `R${row}-P${col}`;
  return fallback;
}

function byValue(a: PlantRanking, b: PlantRanking): number {
  return a.value - b.value || a.plant_id.localeCompare(b.plant_id);
}

/**
 * The N weakest plants of a ranking page. The server already orders (`order=asc`) and ranks, but
 * the same helper feeds cards that hold a `desc` page or a merged set — so sort a copy, never the
 * caller's array, with the server's tie-break (`plant_id`). Non-alive plants belong to the replant
 * list, not the ranking, and are dropped here too.
 */
export function weakestN(items: PlantRanking[], n: number): PlantRanking[] {
  return items
    .filter((p) => p.status === 'alive')
    .sort(byValue)
    .slice(0, Math.max(0, n));
}

/** The N strongest plants, same rules mirrored. */
export function strongestN(items: PlantRanking[], n: number): PlantRanking[] {
  return items
    .filter((p) => p.status === 'alive')
    .sort((a, b) => byValue(b, a))
    .slice(0, Math.max(0, n));
}

/**
 * `vs_block_pct` as a signed percentage, e.g. `+12%` / `−8%` (U+2212 minus, matching `Delta` in
 * components/ui). Null when the server could not compute it (no block, or a zero block median).
 */
export function formatVsBlock(pct: number | null | undefined): string | null {
  if (pct == null || Number.isNaN(pct)) return null;
  const rounded = Math.round(pct);
  if (rounded === 0) return '0%';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}%`;
}

/** Robust neighbour z, rendered in the data voice (`z −3.2`); null when it was not computable. */
export function formatZ(z: number | null | undefined): string | null {
  if (z == null || Number.isNaN(z)) return null;
  return `${z < 0 ? '−' : '+'}${Math.abs(z).toFixed(1)}`;
}

/**
 * Neighbour-anomaly severity, frozen in docs/API-PLANT.md §Plant insights: `z ≤ −3.5` critical,
 * `z ≤ −2.5` warning, else info. Lets a ranking row (which only carries `neighbour_z`) pick the
 * same severity backdrop the outlier list and the alert would show.
 */
export function severityForZ(z: number | null | undefined): Severity | null {
  if (z == null || Number.isNaN(z)) return null;
  if (z <= -3.5) return 'critical';
  if (z <= -2.5) return 'warning';
  return 'info';
}

/** Ranking rows grouped by block id (`''` = plants outside any block), order preserved. */
export function groupByBlock<T extends { block_id: string | null }>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = item.block_id ?? '';
    const bucket = out.get(key);
    if (bucket) bucket.push(item);
    else out.set(key, [item]);
  }
  return out;
}

/** Outliers worth surfacing first: most negative z, capped. */
export function worstOutliers(items: PlantOutlier[], n: number): PlantOutlier[] {
  return [...items]
    .sort((a, b) => a.z - b.z || a.plant_id.localeCompare(b.plant_id))
    .slice(0, Math.max(0, n));
}

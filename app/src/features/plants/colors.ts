// OWNER: fe-plant-map — the one colour ramp for per-plant vigor, shared by the MapLibre layer
// (as an `interpolate` expression built from `mapPalette`), the legend, and the ranking list
// so a plant is the same colour everywhere. Terra palette only (docs/DESIGN.md, @/theme).
// HARD design rule: no coloured state dots and no left-border accent stripes anywhere in the
// plant UI — status is carried by the glyph/gradient recipes in @/components/ui + glyphs.
import type { PlantMetric, PlantStatus } from '@/api/types';
import { colors } from '@/theme';

/**
 * Ramp stops for `norm` (0..1, the parcel-wide normalized value carried by every MVT feature).
 * Same stops as the shipped parcel choropleth (`features/insights/format.ts`) so a plant and the
 * parcel it grows in speak one colour language: clay = stressed → straw → leaf = vigorous.
 */
export const VIGOR_RAMP: string[] = [
  '#A5432B',
  '#B26A3F',
  '#C7A34E',
  '#B8BF5C',
  '#7BA653',
  '#3F7D45',
];

/**
 * `canopy_m2` / `height_m` are sizes, not health — the vigor ramp would paint a legitimately
 * small young tree as stressed. Sequential leaf green instead: pale = small, deep = large.
 */
export const SIZE_RAMP: string[] = ['#EAF1E3', '#C3D8B4', '#95BC85', '#659A5C', '#3F7D45'];

/** Plants with no observation for the selected metric+capture (MVT feature without `value`). */
export const NO_DATA_COLOR = colors.textFaint;

export function rampForMetric(metric: PlantMetric): string[] {
  return metric === 'canopy_m2' || metric === 'height_m' ? SIZE_RAMP : VIGOR_RAMP;
}

/**
 * value → 0..1 exactly as the server normalizes the MVT `norm` property
 * (docs/API-PLANT.md §Plant vector tiles): `clamp((v − p5) / (p95 − p5), 0, 1)`, and `0.5` when
 * `p95 == p5`. Map, legend and ranking list must agree, so this is the only normalization in the
 * app — never re-derive it locally.
 */
export function normalizeToScale(
  value: number | null | undefined,
  scale: { p5: number | null; p95: number | null } | null | undefined,
): number | null {
  if (value == null || Number.isNaN(value)) return null;
  if (!scale || scale.p5 == null || scale.p95 == null) return null;
  if (scale.p95 === scale.p5) return 0.5;
  return Math.max(0, Math.min(1, (value - scale.p5) / (scale.p95 - scale.p5)));
}

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Colour for a normalized 0..1 value, interpolated across the ramp — continuous, matching the
 * MapLibre `interpolate` expression stop for stop. Out of range clamps; null = no-data grey.
 */
export function rampColor(norm: number | null | undefined, ramp: string[] = VIGOR_RAMP): string {
  if (norm == null || Number.isNaN(norm)) return NO_DATA_COLOR;
  const t = Math.max(0, Math.min(1, norm));
  const pos = t * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = hexToRgb(ramp[i]);
  const b = hexToRgb(ramp[i + 1]);
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** Colour for a normalized 0..1 value on the vigor ramp. */
export function vigorColor(norm: number | null | undefined): string {
  return rampColor(norm, VIGOR_RAMP);
}

/** Colour for a normalized 0..1 value on the ramp that metric reads best on. */
export function metricColor(metric: PlantMetric, norm: number | null | undefined): string {
  return rampColor(norm, rampForMetric(metric));
}

/** Non-alive plants are drawn muted — they are context for the replant view, not a vigor datum. */
export function isMuted(status: PlantStatus): boolean {
  return status !== 'alive';
}

/** Colour for one list/map datum: muted when the plant is not alive, else the metric ramp. */
export function plantColor(
  status: PlantStatus,
  metric: PlantMetric,
  norm: number | null | undefined,
): string {
  if (isMuted(status)) return colors.textFaint;
  return metricColor(metric, norm);
}

/**
 * Every colour the MapLibre document paints with. That HTML string is a dumb renderer: theme
 * tokens are resolved here and travel inside the init payload, so Terra stays in one place.
 */
export interface PlantMapPalette {
  /** ramp stops, low → high; becomes the circle layer's `interpolate` output */
  ramp: string[];
  /** plant with no value for this metric+capture */
  noData: string;
  /** fill for non-alive plants (missing/dead are drawn — the replant view needs them) */
  muted: string;
  /** outline for non-alive plants */
  mutedStroke: string;
  /** halo around every plant so dense grids stay separable */
  halo: string;
  /** ring on the selected plant */
  selected: string;
  /** ring on a plant carrying an open alert */
  alert: string;
  parcelLine: string;
  parcelFill: string;
}

export function mapPalette(metric: PlantMetric): PlantMapPalette {
  return {
    ramp: rampForMetric(metric),
    noData: NO_DATA_COLOR,
    muted: '#D5D3CA',
    mutedStroke: colors.accent,
    halo: colors.card,
    selected: colors.primaryDark,
    alert: colors.accent,
    parcelLine: colors.primaryDark,
    parcelFill: 'rgba(35, 75, 52, 0.06)',
  };
}

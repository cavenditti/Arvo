// OWNER: fe-dashboard — pure display helpers shared by dashboard/insights UI (no React).
import { enUS, it } from 'date-fns/locale';

import i18n from '@/i18n';
import type { IndexName, LatestIndices, WeatherDaily } from '@/api/types';

/** y-axis domain per index (spec: veg indices 0..1, ndmi -0.2..0.6). */
export const INDEX_DOMAIN: Record<IndexName, [number, number]> = {
  ndvi: [0, 1],
  gndvi: [0, 1],
  savi: [0, 1],
  ndre: [0, 1],
  ndmi: [-0.2, 0.6],
};

/**
 * Practical satellite-signal ranges used by the Arvo Score. These are deliberately
 * narrower than the mathematical index domains so the score remains useful in real
 * field conditions. The score is a simple orientation aid, not a crop-stage model.
 */
const SCORE_RANGE: Record<IndexName, [number, number]> = {
  ndvi: [0.15, 0.85],
  ndre: [0.05, 0.5],
  gndvi: [0.1, 0.75],
  ndmi: [-0.2, 0.5],
  savi: [0.1, 0.7],
};

const SCORE_WEIGHT: Record<IndexName, number> = {
  ndvi: 0.3,
  ndre: 0.2,
  gndvi: 0.15,
  ndmi: 0.2,
  savi: 0.15,
};

export type ScoreBand = 'strong' | 'good' | 'watch' | 'attention';
export type TrendBand = 'improving' | 'stable' | 'declining' | 'unknown';

export interface ArvoScore {
  value: number;
  /** Share of the five weighted signals available, from 0 to 1. */
  coverage: number;
  signalCount: number;
  observedAt: string | null;
}

/** Weighted 0–100 summary of all available vegetation and moisture signals. */
export function arvoScore(latest: LatestIndices | null | undefined): ArvoScore | null {
  if (!latest) return null;
  let weighted = 0;
  let usedWeight = 0;
  let signalCount = 0;
  let observedAt: string | null = null;

  for (const index of Object.keys(SCORE_WEIGHT) as IndexName[]) {
    const point = latest[index];
    if (!point || !Number.isFinite(point.mean)) continue;
    const [min, max] = SCORE_RANGE[index];
    const normalized = Math.max(0, Math.min(1, (point.mean - min) / (max - min)));
    weighted += normalized * SCORE_WEIGHT[index];
    usedWeight += SCORE_WEIGHT[index];
    signalCount += 1;
    if (!observedAt || point.observed_at > observedAt) observedAt = point.observed_at;
  }

  if (usedWeight === 0) return null;
  return {
    value: Math.round((weighted / usedWeight) * 100),
    coverage: usedWeight,
    signalCount,
    observedAt,
  };
}

export function scoreBand(score: number): ScoreBand {
  if (score >= 75) return 'strong';
  if (score >= 55) return 'good';
  if (score >= 35) return 'watch';
  return 'attention';
}

export function scoreColor(score: number | null | undefined): string {
  if (score == null || Number.isNaN(score)) return '#B8C2BC';
  return indexColor('ndvi', Math.max(0, Math.min(100, score)) / 100);
}

/** Human-readable movement from NDVI; raw values stay available in advanced detail. */
export function trendBand(delta: number | null | undefined): TrendBand {
  if (delta == null || Number.isNaN(delta)) return 'unknown';
  if (delta > 0.025) return 'improving';
  if (delta < -0.025) return 'declining';
  return 'stable';
}

// choropleth ramp: bare/stressed (terracotta) → amber → yellow-green → vigorous (forest)
const RAMP = ['#A5432B', '#B26A3F', '#C7A34E', '#B8BF5C', '#7BA653', '#3F7D45'];

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Color for an index value, normalised inside the index domain. */
export function indexColor(index: IndexName, value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '#B8C2BC';
  const [min, max] = INDEX_DOMAIN[index];
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const pos = t * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = hexToRgb(RAMP[i]);
  const b = hexToRgb(RAMP[i + 1]);
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** date-fns locale matching the active UI language. */
export function dfLocale() {
  return i18n.language?.startsWith('it') ? it : enUS;
}

/** Weather glyph from precip/temperature heuristics (no cloud field available). */
export function weatherEmoji(d: Pick<WeatherDaily, 't_min' | 't_max' | 'precip_mm'>): string {
  const p = d.precip_mm ?? 0;
  if (d.t_min != null && d.t_min <= 0) return '❄️';
  if (p >= 10) return '⛈️';
  if (p >= 3) return '🌧️';
  if (p > 0) return '🌦️';
  if (d.t_max != null && d.t_max >= 32) return '☀️';
  if (d.t_max != null && d.t_max >= 20) return '🌤️';
  return '⛅';
}

const CROP_LABELS: Record<string, { it: string; en: string }> = {
  vine: { it: 'Vite', en: 'Vine' },
  olive: { it: 'Olivo', en: 'Olive' },
  tomato: { it: 'Pomodoro', en: 'Tomato' },
  wheat: { it: 'Frumento', en: 'Wheat' },
  maize: { it: 'Mais', en: 'Maize' },
  other: { it: 'Altro', en: 'Other' },
};

/** Friendly crop label (crop is a free string; known crops are localised). */
export function cropLabel(crop: string | null | undefined): string {
  if (!crop) return '';
  const e = CROP_LABELS[crop];
  if (!e) return crop;
  return i18n.language?.startsWith('it') ? e.it : e.en;
}

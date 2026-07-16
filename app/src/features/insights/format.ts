// OWNER: fe-dashboard — pure display helpers shared by dashboard/insights UI (no React).
import { enUS, it } from 'date-fns/locale';

import i18n from '@/i18n';
import type { IndexName, WeatherDaily } from '@/api/types';

/** y-axis domain per index (spec: veg indices 0..1, ndmi -0.2..0.6). */
export const INDEX_DOMAIN: Record<IndexName, [number, number]> = {
  ndvi: [0, 1],
  gndvi: [0, 1],
  savi: [0, 1],
  ndre: [0, 1],
  ndmi: [-0.2, 0.6],
};

// choropleth ramp: bare/stressed (brown) → yellow → vigorous (green)
const RAMP = ['#A1442A', '#D98C3F', '#E8C443', '#7CB342', '#2E7D32'];

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

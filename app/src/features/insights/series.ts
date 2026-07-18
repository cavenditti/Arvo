// Index time-series helpers shared by the dashboards and parcel screens.
import type { IndexPoint } from '@/api/types';

const DAY_MS = 86_400_000;

/** Change in mean vs the last point ≥7 days older than the newest (null = not enough data). */
export function sevenDayDelta(series: IndexPoint[]): number | null {
  if (series.length < 2) return null;
  const latest = series[series.length - 1];
  const cutoff = Date.parse(latest.observed_at) - 7 * DAY_MS;
  for (let i = series.length - 2; i >= 0; i--) {
    if (Date.parse(series[i].observed_at) <= cutoff) {
      return latest.mean - series[i].mean;
    }
  }
  return latest.mean - series[0].mean;
}

/** Change in mean vs the immediately previous acquisition (null = fewer than 2 points). */
export function lastPassDelta(series: IndexPoint[]): number | null {
  if (series.length < 2) return null;
  return series[series.length - 1].mean - series[series.length - 2].mean;
}

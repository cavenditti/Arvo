// Severity ordering + alert aggregation helpers shared by the dashboards, map, and parcel
// screens (previously re-declared inline in five files, drifting one bug at a time).
import type { Alert } from '@/api/types';

export const SEVERITY_RANK: Record<string, number> = { info: 1, warning: 2, critical: 3 };

export function severityRank(severity: string | null | undefined): number {
  return SEVERITY_RANK[severity ?? ''] ?? 0;
}

/** Worst OPEN severity per parcel id (undefined = no open alerts for that parcel). */
export function worstSeverityByParcel(alerts: Alert[]): Record<string, string> {
  const worst: Record<string, string> = {};
  for (const a of alerts) {
    if (a.state !== 'open' || !a.parcel_id) continue;
    if (severityRank(a.severity) > severityRank(worst[a.parcel_id])) {
      worst[a.parcel_id] = a.severity;
    }
  }
  return worst;
}

/** Worst open alert of a single parcel's list (undefined when none are open). */
export function worstOpenAlert(alerts: Alert[]): Alert | undefined {
  return alerts
    .filter((a) => a.state === 'open')
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0];
}

/** Severity first (critical → info), then recency. For banner/top-N lists. */
export function sortBySeverityThenRecency(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => {
    const d = severityRank(b.severity) - severityRank(a.severity);
    if (d !== 0) return d;
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  });
}

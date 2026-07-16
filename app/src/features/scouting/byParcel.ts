// OWNER: fe-scouting — read-side helper: observations for one parcel from the offline store
// (newest first). Starts the store/sync loop on first use; safe on web and native.
import { useEffect } from 'react';

import type { Observation } from '@/api/types';
import { useScouting } from '@/offline/hooks';
import { ensureStarted, sync } from '@/offline/queue';

export function useParcelObservations(parcelId: string | null | undefined): Observation[] {
  const snap = useScouting();
  useEffect(() => {
    ensureStarted();
    void sync();
  }, []);
  if (!parcelId) return [];
  return snap.observations
    .filter((o) => o.parcel_id === parcelId && !o.deleted)
    .sort((a, b) => b.taken_at.localeCompare(a.taken_at));
}

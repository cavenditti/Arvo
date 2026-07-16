// OWNER: fe-scouting — React bindings over the module-level scouting store (queue.ts).
import { useCallback, useSyncExternalStore } from 'react';

import { getSnapshot, subscribe, sync, type ScoutingSnapshot } from './queue';

/** Full reactive snapshot of the local scouting store. */
export function useScouting(): ScoutingSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Sync status + a manual trigger, per the fe-scouting contract. */
export function useSync(): {
  pendingCount: number;
  syncing: boolean;
  lastSync: string | null;
  error: string | null;
  syncNow: () => void;
} {
  const snap = useScouting();
  const syncNow = useCallback(() => {
    void sync();
  }, []);
  return {
    pendingCount: snap.pendingCount,
    syncing: snap.syncing,
    lastSync: snap.lastSync,
    error: snap.error,
    syncNow,
  };
}

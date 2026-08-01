// OWNER: offline-persist — react-query cache persistence, so a field with no signal still
// shows the last good reads instead of empty screens. shell-nav wires this into the root
// layout via <PersistQueryClientProvider client={queryClient} persistOptions={queryPersistOptions}>.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { PersistQueryClientOptions } from '@tanstack/react-query-persist-client';

/**
 * Query-key prefixes (queryKey[0]) that are safe AND useful to restore offline.
 * Verified against the actual spellings in src/features + src/app:
 * - contract list `parcels/farms/alerts/indices/weather/agro/advisories/meta` matches code;
 * - `parcel` (detail reads, `['parcel', id]`) added — it IS the "field with no signal" screen;
 * - the contract's `me` is spelled `['auth', 'me']` in code and is special-cased below so the
 *   rest of the `auth` prefix can never be persisted.
 * Deliberately excluded: `media-token` (short-lived signed token — never persist), and the
 * heavy per-plant/capture families (`plant*`, `capture*`, `scenes`) which refetch fine.
 */
const WHITELIST = [
  'parcels',
  'parcel',
  'farms',
  'alerts',
  'indices',
  'weather',
  'agro',
  'advisories',
  'meta',
];

const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: 'arvo.querycache.v1',
  // Batch rapid cache updates into one AsyncStorage write.
  throttleTime: 2_000,
});

export const queryPersistOptions: Omit<PersistQueryClientOptions, 'queryClient'> = {
  persister,
  maxAge: 24 * 60 * 60 * 1000, // a day-old read is still better than a blank field screen
  buster: 'v1',
  dehydrateOptions: {
    shouldDehydrateQuery: (q) => {
      if (q.state.status !== 'success') return false;
      const head = String(q.queryKey[0]);
      // Current-user profile ({ user, org, role } — no credentials). Exact key only:
      // nothing else under the `auth` prefix may ever reach disk.
      if (head === 'auth') return q.queryKey.length === 2 && q.queryKey[1] === 'me';
      return WHITELIST.some((p) => head === p);
    },
  },
};

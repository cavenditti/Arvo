// Parcel id → name lookup used by alert lists, feeds, and banners (was rebuilt inline in
// five screens). Piggybacks on the canonical ['parcels'] cache entry.
import { useMemo } from 'react';

import { useParcels } from './hooks';

export function useParcelNames(): Record<string, string> {
  const parcelsQ = useParcels();
  return useMemo(() => {
    const names: Record<string, string> = {};
    for (const p of parcelsQ.data ?? []) names[p.id] = p.name;
    return names;
  }, [parcelsQ.data]);
}

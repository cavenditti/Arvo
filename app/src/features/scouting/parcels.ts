// OWNER: fe-scouting — nearest-centroid helpers for offline auto-pick. The parcels query
// itself lives in features/parcels/hooks (one canonical ['parcels'] registration); this
// module re-exports it so scouting imports stay stable.
import type { Parcel } from '@/api/types';

export { useParcels } from '@/features/parcels/hooks';

/** Great-circle distance in km (haversine). */
export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Nearest parcel by centroid within `maxKm`, or null. */
export function nearestParcel(
  parcels: Parcel[],
  lat: number,
  lon: number,
  maxKm = 2,
): Parcel | null {
  let best: Parcel | null = null;
  let bestD = Infinity;
  for (const p of parcels) {
    const d = distanceKm(lat, lon, p.centroid.lat, p.centroid.lon);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best && bestD <= maxKm ? best : null;
}

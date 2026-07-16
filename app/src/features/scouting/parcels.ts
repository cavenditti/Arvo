// OWNER: fe-scouting — parcels cache (react-query) with an AsyncStorage fallback so parcel
// name lookup + nearest-parcel auto-pick keep working offline, plus nearest-centroid helpers.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { api } from '@/api/client';
import type { Parcel } from '@/api/types';

const PARCELS_CACHE_KEY = 'arvo.cache.parcels';

export function useParcels(): UseQueryResult<Parcel[]> {
  return useQuery({
    queryKey: ['parcels'],
    staleTime: 5 * 60 * 1000,
    // 'always' so the queryFn runs even when the client is considered offline (web) — the
    // AsyncStorage fallback below then serves the last-known parcels for offline auto-pick.
    networkMode: 'always',
    queryFn: async (): Promise<Parcel[]> => {
      try {
        const parcels = await api.get<Parcel[]>('/parcels');
        void AsyncStorage.setItem(PARCELS_CACHE_KEY, JSON.stringify(parcels));
        return parcels;
      } catch (e) {
        const cached = await AsyncStorage.getItem(PARCELS_CACHE_KEY);
        if (cached) return JSON.parse(cached) as Parcel[];
        throw e;
      }
    },
  });
}

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

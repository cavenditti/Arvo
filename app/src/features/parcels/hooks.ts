// OWNER: fe-map — react-query hooks for parcels/farms/indices/weather/alerts used by the map tab
// and parcel screens. Server state only; all access goes through the shared api client.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/api/client';
import type {
  Advisory,
  AgroSummary,
  Alert,
  Farm,
  IndexName,
  IndexPoint,
  LatestIndices,
  Parcel,
  ParcelGeometry,
  WeatherDaily,
} from '@/api/types';

const PARCELS_CACHE_KEY = 'arvo.cache.parcels';

/** The one canonical ['parcels'] query. AsyncStorage fallback keeps parcel-name lookup and
 * the scouting nearest-parcel auto-pick working offline; every screen shares this cache
 * entry (two registrations of the same key with different behaviours caused cache roulette). */
export function useParcels() {
  return useQuery({
    queryKey: ['parcels'],
    staleTime: 5 * 60 * 1000,
    // 'always' so the queryFn runs even when the client is considered offline (web) — the
    // AsyncStorage fallback below then serves the last-known parcels.
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

/** Wipe the offline parcels fallback (logout / org switch — see AuthContext). */
export async function clearParcelsCache(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PARCELS_CACHE_KEY);
  } catch {
    // cache is best-effort
  }
}

export function useParcel(id: string) {
  return useQuery({
    queryKey: ['parcel', id],
    queryFn: () => api.get<Parcel>(`/parcels/${id}`),
    enabled: !!id,
  });
}

export function useFarms() {
  return useQuery({ queryKey: ['farms'], queryFn: () => api.get<Farm[]>('/farms') });
}

export function useLatestIndices(parcelIds: string[]) {
  const ids = parcelIds.join(',');
  return useQuery({
    queryKey: ['indices', 'latest', ids],
    queryFn: () => api.get<Record<string, LatestIndices>>(`/indices/latest?parcel_ids=${ids}`),
    enabled: parcelIds.length > 0,
  });
}

export function useIndexSeries(id: string, index: IndexName) {
  return useQuery({
    queryKey: ['indices', id, index],
    queryFn: () => api.get<{ index: IndexName; series: IndexPoint[] }>(
      `/parcels/${id}/indices?index=${index}`,
    ),
    enabled: !!id,
  });
}

export function useWeather(id: string) {
  return useQuery({
    queryKey: ['weather', id],
    queryFn: () => api.get<{ daily: WeatherDaily[] }>(`/parcels/${id}/weather`),
    enabled: !!id,
  });
}

export function useAgro(id: string) {
  return useQuery({
    queryKey: ['agro', id],
    queryFn: () => api.get<AgroSummary>(`/parcels/${id}/agro`),
    enabled: !!id,
  });
}

export function useAdvisories(id: string) {
  return useQuery({
    queryKey: ['advisories', id],
    queryFn: () => api.get<Advisory[]>(`/parcels/${id}/advisories`),
    enabled: !!id,
  });
}

export function useParcelAlerts(id: string) {
  return useQuery({
    queryKey: ['alerts', 'parcel', id],
    queryFn: () => api.get<Alert[]>(`/alerts?parcel_id=${id}`),
    enabled: !!id,
  });
}

export interface CreateParcelInput {
  farm_id: string;
  name: string;
  geometry: ParcelGeometry;
  crop?: string;
  variety?: string;
  planting_date?: string;
  season_year?: number;
}

export function useCreateParcel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateParcelInput) => api.post<Parcel>('/parcels', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['parcels'] }),
  });
}

export type UpdateParcelInput = Partial<
  Pick<Parcel, 'name' | 'crop' | 'variety' | 'planting_date' | 'season_year'>
> & { geometry?: ParcelGeometry };

export function useUpdateParcel(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateParcelInput) => api.patch<Parcel>(`/parcels/${id}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['parcel', id] });
      qc.invalidateQueries({ queryKey: ['parcels'] });
    },
  });
}

export function useArchiveParcel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/parcels/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['parcels'] }),
  });
}

export function useCreateFarm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<Farm>('/farms', { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['farms'] }),
  });
}

export interface ImportResult {
  created: Parcel[];
  skipped?: number;
}

export function useImportParcels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { farm_id: string; feature_collection: unknown }) =>
      api.post<ImportResult>('/parcels/import', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['parcels'] }),
  });
}

export interface RefreshImageryResult {
  scenes_found: number;
  scenes_new: number;
  computed: number;
}

export function useRefreshImagery(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<RefreshImageryResult>(`/parcels/${id}/imagery/refresh`, {}),
    // A successful refresh may have computed new observations — the chart, sparkline and
    // latest-stats caches for this parcel are all stale now.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['indices'] });
      void qc.invalidateQueries({ queryKey: ['scenes', id] });
    },
  });
}

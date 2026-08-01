// OWNER: fe-map — react-query hooks for parcels/farms/indices/weather/alerts used by the map tab
// and parcel screens. Server state only; all access goes through the shared api client.
import { Platform } from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { API_URL, api, getAuthToken } from '@/api/client';
import type {
  Advisory,
  AgroSummary,
  Alert,
  CadastralDetection,
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
  cadastral_ref?: string;
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

// --- parcel/new save helpers: the farm concept disappears for the common case ---
// (docs/UX-REVAMP.md parcel-flow) A first-time user never names or picks a farm: when the
// org has none, one is created silently right before the parcel, in the same mutation.

/** Resolve the target farm id, silently creating a farm named `autoName` when needed.
 * Invalidates ['farms'] immediately after a creation so a failed follow-up (parcel create)
 * leaves the client aware of the new farm instead of silently re-creating it on retry. */
async function ensureFarmId(
  qc: ReturnType<typeof useQueryClient>,
  farmId: string | null,
  autoName: string,
): Promise<string> {
  if (farmId) return farmId;
  const farm = await api.post<Farm>('/farms', { name: autoName });
  void qc.invalidateQueries({ queryKey: ['farms'] });
  return farm.id;
}

export interface CreateParcelAutoFarmInput {
  /** null → create a farm named `autoFarmName` first, then the parcel inside it */
  farmId: string | null;
  autoFarmName: string;
  parcel: Omit<CreateParcelInput, 'farm_id'>;
}

/** POST /farms (only when the org has none) then POST /parcels — one mutation per save tap. */
export function useCreateParcelAutoFarm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ farmId, autoFarmName, parcel }: CreateParcelAutoFarmInput) => {
      const fid = await ensureFarmId(qc, farmId, autoFarmName);
      return api.post<Parcel>('/parcels', { ...parcel, farm_id: fid });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['parcels'] }),
  });
}

export interface ImportParcelsAutoFarmInput {
  farmId: string | null;
  autoFarmName: string;
  feature_collection: unknown;
}

/** Same silent-farm rule for the cadastre multi-select / GeoJSON-file bulk import path. */
export function useImportParcelsAutoFarm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ farmId, autoFarmName, feature_collection }: ImportParcelsAutoFarmInput) => {
      const fid = await ensureFarmId(qc, farmId, autoFarmName);
      return api.post<ImportResult>('/parcels/import', { farm_id: fid, feature_collection });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['parcels'] }),
  });
}

/** Round a bbox for cache identity: ~1e-4 deg ≈ 10 m — pans smaller than that reuse the
 * cached detection instead of hammering the public WFS. */
function bboxKey(bbox: [number, number, number, number]): string {
  return bbox.map((v) => v.toFixed(4)).join(',');
}

/** Cadastral candidates for the current viewport (FR-0-010b). Pass null while the user is
 * zoomed out or the mode is off; each settled viewport is fetched once and cached. */
export function useCadastralParcels(bbox: [number, number, number, number] | null) {
  return useQuery({
    queryKey: ['cadastre', bbox ? bboxKey(bbox) : 'off'],
    queryFn: () =>
      api.get<CadastralDetection>(`/cadastre/parcels?bbox=${bbox!.map((v) => v.toFixed(6)).join(',')}`),
    enabled: !!bbox,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
}

export interface ParcelPhotoInput {
  parcelId: string;
  /** local asset from expo-image-picker */
  uri: string;
  name: string;
  mime: string;
}

/** Upload/replace a parcel cover photo (multipart, like scouting photos). */
async function uploadParcelPhoto(input: ParcelPhotoInput): Promise<{ path: string }> {
  const form = new FormData();
  if (Platform.OS === 'web') {
    const resp = await fetch(input.uri);
    form.append('file', await resp.blob(), input.name);
  } else {
    // React Native multipart file part
    form.append('file', {
      uri: input.uri,
      name: input.name,
      type: input.mime,
    } as unknown as Blob);
  }
  const token = getAuthToken();
  const res = await fetch(`${API_URL}/api/v1/parcels/${input.parcelId}/photo`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (!res.ok) throw new Error(`photo_upload_${res.status}`);
  return (await res.json()) as { path: string };
}

export function useSetParcelPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: uploadParcelPhoto,
    onSuccess: (_, input) => {
      void qc.invalidateQueries({ queryKey: ['parcel', input.parcelId] });
      void qc.invalidateQueries({ queryKey: ['parcels'] });
    },
  });
}

export function useRemoveParcelPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (parcelId: string) => api.del<void>(`/parcels/${parcelId}/photo`),
    onSuccess: (_, parcelId) => {
      void qc.invalidateQueries({ queryKey: ['parcel', parcelId] });
      void qc.invalidateQueries({ queryKey: ['parcels'] });
    },
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

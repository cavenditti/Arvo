// OWNER: fe-plant-map — react-query hooks for the plant tier (plants, blocks/rows, captures,
// ranking, outliers, replant, series, metric scale). Server state only; every call goes through
// the shared api client, types from @/api/types, endpoints from docs/API-PLANT.md.
// Query-key convention (keep it, other screens invalidate against these):
//   ['plants', parcelId, filters] · ['plant', id] · ['plant-series', id, metric]
//   ['plant-summary', parcelId] · ['plant-ranking', parcelId, metric, capture, order, offset]
//   ['plant-outliers', parcelId, metric, capture] · ['plant-replant', parcelId, blockId]
//   ['plant-scale', parcelId, metric, capture] · ['captures', parcelId] · ['capture', id]
//   ['capture-status', id]   (refetchInterval 5s while status ∉ {extracted, failed})
// Multipart asset upload (POST /captures/{id}/assets/{kind}) is NOT here: FormData differs
// between web and native, so fe-capture owns it in the capture screen.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { API_URL, api } from '@/api/client';
import { useMediaToken } from '@/features/media';
import type {
  Capture,
  CaptureSource,
  CaptureStatus,
  CaptureStatusInfo,
  GeoJSONPolygon,
  MetricScale,
  Page,
  PipelineStage,
  Plant,
  PlantAlert,
  PlantBlock,
  PlantCaptureEntry,
  PlantGrowthResponse,
  PlantImportResult,
  PlantLatestMetrics,
  PlantMetric,
  PlantOutliersResponse,
  PlantRankingResponse,
  PlantRow,
  PlantSeriesResponse,
  PlantStatus,
  PlantSummary,
  PlantUnit,
  ReplantEntry,
} from '@/api/types';

type Params = Record<string, string | number | boolean | null | undefined>;

function qs(params: Params): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// ─── Plants ──────────────────────────────────────────────────────────────────

export interface PlantFilters {
  parcel_id?: string;
  block_id?: string;
  row_id?: string;
  /** comma list; the server defaults to "everything except removed" */
  status?: string;
  unit_type?: PlantUnit;
  /** `w,s,e,n` */
  bbox?: string;
  /** substring on label / external_ref */
  q?: string;
  limit?: number;
  offset?: number;
}

/**
 * A parcel can hold 200k plants, so this list is always scoped and paged: the API rejects a
 * request without one of parcel_id / block_id / row_id, which is exactly the `enabled` guard.
 */
export function usePlants(filters: PlantFilters) {
  const scope = filters.parcel_id ?? filters.block_id ?? filters.row_id ?? '';
  return useQuery({
    queryKey: ['plants', scope, filters],
    queryFn: () => api.get<Page<Plant>>(`/plants${qs({ ...filters })}`),
    enabled: !!scope,
  });
}

export function usePlant(id: string) {
  return useQuery({
    queryKey: ['plant', id],
    queryFn: () => api.get<Plant>(`/plants/${id}`),
    enabled: !!id,
  });
}

export function usePlantBlocks(parcelId: string) {
  return useQuery({
    queryKey: ['plant-blocks', parcelId],
    queryFn: () => api.get<PlantBlock[]>(`/parcels/${parcelId}/plant-blocks`),
    enabled: !!parcelId,
  });
}

export function usePlantRows(parcelId: string, blockId?: string) {
  return useQuery({
    queryKey: ['plant-rows', parcelId, blockId ?? null],
    queryFn: () => api.get<PlantRow[]>(`/parcels/${parcelId}/plant-rows${qs({ block_id: blockId })}`),
    enabled: !!parcelId,
  });
}

export function usePlantSummary(parcelId: string) {
  return useQuery({
    queryKey: ['plant-summary', parcelId],
    queryFn: () => api.get<PlantSummary>(`/parcels/${parcelId}/plants/summary`),
    enabled: !!parcelId,
  });
}

export interface CreatePlantInput {
  parcel_id: string;
  lon: number;
  lat: number;
  unit_type?: PlantUnit;
  label?: string;
  block_id?: string;
  row_id?: string;
  row_index?: number;
  col_index?: number;
  variety?: string;
  rootstock?: string;
  planted_on?: string;
  status?: PlantStatus;
  external_ref?: string;
  crown?: GeoJSONPolygon;
}

/** Everything a plant list/map/detail derives from one plant — invalidated after any mutation. */
function invalidatePlant(
  qc: ReturnType<typeof useQueryClient>,
  parcelId: string | undefined,
  plantId?: string,
) {
  void qc.invalidateQueries({ queryKey: ['plants'] });
  if (plantId) void qc.invalidateQueries({ queryKey: ['plant', plantId] });
  if (parcelId) {
    void qc.invalidateQueries({ queryKey: ['plant-summary', parcelId] });
    void qc.invalidateQueries({ queryKey: ['plant-ranking', parcelId] });
    void qc.invalidateQueries({ queryKey: ['plant-replant', parcelId] });
  }
}

export function useCreatePlant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePlantInput) => api.post<Plant>('/plants', input),
    onSuccess: (plant) => invalidatePlant(qc, plant.parcel_id, plant.id),
  });
}

/** Any field except id / parcel_id / source; an explicit null clears a nullable field. */
export type UpdatePlantInput = Partial<
  Omit<CreatePlantInput, 'parcel_id'> & {
    label: string | null;
    external_ref: string | null;
    variety: string | null;
    rootstock: string | null;
    planted_on: string | null;
    block_id: string | null;
    row_id: string | null;
    row_index: number | null;
    col_index: number | null;
  }
>;

export function useUpdatePlant(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdatePlantInput) => api.patch<Plant>(`/plants/${id}`, patch),
    onSuccess: (plant) => invalidatePlant(qc, plant.parcel_id, plant.id),
  });
}

/** Status transition (mark dead / missing / replanted) — audited server-side as `plant.status`. */
export function useSetPlantStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { status: PlantStatus; note?: string }) =>
      api.post<Plant>(`/plants/${id}/status`, input),
    onSuccess: (plant) => {
      invalidatePlant(qc, plant.parcel_id, plant.id);
      void qc.invalidateQueries({ queryKey: ['plant-alerts'] });
    },
  });
}

/** Soft delete: the server sets status = "removed" and keeps the history. */
export function useDeletePlant(parcelId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/plants/${id}`),
    onSuccess: (_res, id) => invalidatePlant(qc, parcelId, id),
  });
}

export function useImportPlants() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { parcel_id: string; unit_type?: PlantUnit; feature_collection: unknown }) =>
      api.post<PlantImportResult>('/plants/import', input),
    onSuccess: (_res, input) => invalidatePlant(qc, input.parcel_id),
  });
}

// ─── Insights (ranking · outliers · replant · series · scale) ────────────────

export interface RankingOptions {
  metric?: PlantMetric;
  /** `latest` (default) or a capture uuid */
  capture?: string;
  block_id?: string;
  row_id?: string;
  /** asc = weakest first (default) */
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export function usePlantRanking(parcelId: string, opts: RankingOptions = {}) {
  const { metric = 'ndvi', capture = 'latest', order = 'asc', offset = 0 } = opts;
  const params = { ...opts, metric, capture, order, offset };
  return useQuery({
    queryKey: ['plant-ranking', parcelId, metric, capture, order, offset, opts],
    queryFn: () =>
      api.get<PlantRankingResponse>(`/parcels/${parcelId}/plants/ranking${qs(params)}`),
    enabled: !!parcelId,
  });
}

export interface OutlierOptions {
  metric?: PlantMetric;
  capture?: string;
  block_id?: string;
  /** neighbours per plant, 3–32 (default 8) */
  k?: number;
  /** neighbour search radius, 5–100 m (default 25) */
  radius_m?: number;
  /** robust-z threshold, −6..−1 (default −2.5) */
  z?: number;
  limit?: number;
}

export function usePlantOutliers(parcelId: string, opts: OutlierOptions = {}) {
  const { metric = 'ndvi', capture = 'latest' } = opts;
  const params = { ...opts, metric, capture };
  return useQuery({
    queryKey: ['plant-outliers', parcelId, metric, capture, opts],
    queryFn: () =>
      api.get<PlantOutliersResponse>(`/parcels/${parcelId}/plants/outliers${qs(params)}`),
    enabled: !!parcelId,
  });
}

export function useReplantList(
  parcelId: string,
  opts: { block_id?: string; limit?: number; offset?: number } = {},
) {
  return useQuery({
    queryKey: ['plant-replant', parcelId, opts.block_id ?? null, opts.offset ?? 0],
    queryFn: () => api.get<Page<ReplantEntry>>(`/parcels/${parcelId}/plants/replant${qs(opts)}`),
    enabled: !!parcelId,
  });
}

/** The per-plant growth curve too (FR-P-044) — `canopy_m2` / `height_m` are just metrics here. */
export function usePlantSeries(
  plantId: string,
  metric: PlantMetric = 'ndvi',
  opts: { from?: string; to?: string; limit?: number } = {},
) {
  return useQuery({
    queryKey: ['plant-series', plantId, metric, opts],
    queryFn: () =>
      api.get<PlantSeriesResponse>(`/plants/${plantId}/series${qs({ metric, ...opts })}`),
    enabled: !!plantId,
  });
}

export function usePlantLatestMetrics(plantId: string) {
  return useQuery({
    queryKey: ['plant-latest', plantId],
    queryFn: () => api.get<PlantLatestMetrics>(`/plants/${plantId}/metrics/latest`),
    enabled: !!plantId,
  });
}

export function usePlantCaptureHistory(plantId: string, limit = 20) {
  return useQuery({
    queryKey: ['plant-captures', plantId, limit],
    queryFn: () => api.get<PlantCaptureEntry[]>(`/plants/${plantId}/captures${qs({ limit })}`),
    enabled: !!plantId,
  });
}

export function usePlantGrowth(
  parcelId: string,
  metric: PlantMetric = 'canopy_m2',
  opts: { block_id?: string; from?: string; to?: string } = {},
) {
  return useQuery({
    queryKey: ['plant-growth', parcelId, metric, opts],
    queryFn: () =>
      api.get<PlantGrowthResponse>(`/parcels/${parcelId}/plants/growth${qs({ metric, ...opts })}`),
    enabled: !!parcelId,
  });
}

/**
 * The colour-ramp domain behind the tiles' `norm` property. The map, the legend and the ranking
 * list all normalize through this one scale (features/plants/colors → normalizeToScale).
 */
export function usePlantMetricScale(parcelId: string, metric: PlantMetric, capture = 'latest') {
  return useQuery({
    queryKey: ['plant-scale', parcelId, metric, capture],
    queryFn: () =>
      api.get<MetricScale>(`/parcels/${parcelId}/plants/metric-scale${qs({ metric, capture })}`),
    enabled: !!parcelId,
  });
}

/**
 * MVT template for PlantMap. Vector tiles are fetched by MapLibre without our auth header, so the
 * URL carries a 15-min media token — a session JWT in a query string is rejected by the API.
 * Null until the token lands; PlantMap simply shows its loading note until then.
 */
export function usePlantTileUrl(
  parcelId: string,
  metric: PlantMetric,
  capture = 'latest',
): string | null {
  const token = useMediaToken();
  if (!parcelId || !token) return null;
  return `${API_URL}/api/v1/tiles/plants/${parcelId}/{z}/{x}/{y}.mvt${qs({
    metric,
    capture,
    token,
  })}`;
}

// ─── Plant alerts (ordinary alert rows; lifecycle stays in features/insights) ─

export function usePlantAlerts(
  filters: { parcel_id?: string; plant_id?: string; state?: string; kind?: string; limit?: number } = {},
) {
  return useQuery({
    queryKey: ['plant-alerts', filters],
    queryFn: () => api.get<PlantAlert[]>(`/plant-alerts${qs(filters)}`),
    enabled: !!(filters.parcel_id || filters.plant_id),
  });
}

export function useAlertsForPlant(plantId: string, state?: string) {
  return useQuery({
    queryKey: ['plant-alerts', 'plant', plantId, state ?? null],
    queryFn: () => api.get<PlantAlert[]>(`/plants/${plantId}/alerts${qs({ state })}`),
    enabled: !!plantId,
  });
}

// ─── Captures ────────────────────────────────────────────────────────────────

export function useCaptures(parcelId?: string, opts: { status?: CaptureStatus; limit?: number } = {}) {
  return useQuery({
    queryKey: ['captures', parcelId ?? null, opts],
    queryFn: () => api.get<Capture[]>(`/captures${qs({ parcel_id: parcelId, ...opts })}`),
  });
}

/** Includes `assets` and `jobs` (the list endpoint omits both). */
export function useCapture(id: string) {
  return useQuery({
    queryKey: ['capture', id],
    queryFn: () => api.get<Capture>(`/captures/${id}`),
    enabled: !!id,
  });
}

/** The cheap poll target: 5 s while the pipeline is still moving, then it stops on its own. */
export function useCaptureStatus(id: string) {
  return useQuery({
    queryKey: ['capture-status', id],
    queryFn: () => api.get<CaptureStatusInfo>(`/captures/${id}/status`),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'extracted' || status === 'failed' ? false : 5_000;
    },
  });
}

export interface CreateCaptureInput {
  parcel_id: string;
  captured_at: string;
  source?: CaptureSource;
  unit_type?: PlantUnit;
  sensor?: string;
  gsd_cm?: number;
  bands?: Record<string, number>;
  pilot_name?: string;
  operator_id?: string;
  drone_model?: string;
  flight_ref?: string;
  notes?: string;
}

export function useCreateCapture() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCaptureInput) => api.post<Capture>('/captures', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['captures'] }),
  });
}

function invalidateCapture(qc: ReturnType<typeof useQueryClient>, capture: Capture) {
  void qc.invalidateQueries({ queryKey: ['captures'] });
  void qc.invalidateQueries({ queryKey: ['capture', capture.id] });
  void qc.invalidateQueries({ queryKey: ['capture-status', capture.id] });
}

/** Enqueues the first pipeline stage. Idempotent server-side — a queued job is never duplicated. */
export function useProcessCapture() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Capture>(`/captures/${id}/process`, {}),
    onSuccess: (capture) => invalidateCapture(qc, capture),
  });
}

/** Re-queues a failed stage (default: the capture's `failed_stage`). */
export function useRetryCapture() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; stage?: PipelineStage }) =>
      api.post<Capture>(`/captures/${input.id}/retry`, { stage: input.stage }),
    onSuccess: (capture) => invalidateCapture(qc, capture),
  });
}

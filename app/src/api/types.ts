// SPINE (read-only for feature agents) — mirrors docs/API.md. Keep in sync with the backend.

export type Role = 'viewer' | 'operator' | 'agronomist' | 'admin' | 'owner';
export type IndexName = 'ndvi' | 'ndre' | 'gndvi' | 'ndmi' | 'savi';
export const INDEX_NAMES: IndexName[] = ['ndvi', 'ndre', 'gndvi', 'ndmi', 'savi'];

export interface User {
  id: string;
  email: string;
  full_name: string;
  locale: string;
}

export interface Org {
  id: string;
  name: string;
}

export interface AuthResponse {
  token: string;
  user: User;
  org?: Org;
  orgs?: { id: string; name: string; role: Role }[];
}

export interface Farm {
  id: string;
  name: string;
  created_at: string;
  parcel_count?: number;
}

export type GeoJSONPolygon = {
  type: 'Polygon';
  coordinates: number[][][];
};
export type GeoJSONMultiPolygon = {
  type: 'MultiPolygon';
  coordinates: number[][][][];
};
export type GeoJSONLineString = {
  type: 'LineString';
  coordinates: number[][];
};
export type GeoJSONPoint = {
  type: 'Point';
  coordinates: number[];
};
export type ParcelGeometry = GeoJSONPolygon | GeoJSONMultiPolygon;

export interface Parcel {
  id: string;
  farm_id: string;
  name: string;
  geometry: ParcelGeometry;
  area_ha: number;
  centroid: { lon: number; lat: number };
  bbox: [number, number, number, number];
  crop: string | null;
  variety: string | null;
  planting_date: string | null;
  season_year: number | null;
  archived: boolean;
  created_at: string;
}

export interface IndexPoint {
  observed_at: string;
  mean: number;
  median: number | null;
  p10: number | null;
  p90: number | null;
  stddev: number | null;
  pixel_count: number | null;
  cloud_pct: number | null;
  scene_id?: string | null;
  // 'drone' rows are the Phase-P parcel rollup written by the capture pipeline
  // (docs/API-PLANT.md §Pipeline stages → rollup).
  source: 'sentinel-2' | 'demo' | 'drone';
}

export type LatestIndices = Record<IndexName, IndexPoint | null>;

export interface Scene {
  id: string;
  stac_id: string;
  acquired_at: string;
  cloud_cover: number | null;
}

export interface WeatherDaily {
  date: string;
  t_min: number | null;
  t_max: number | null;
  t_mean: number | null;
  precip_mm: number | null;
  humidity_mean: number | null;
  wind_max_kmh: number | null;
  radiation_mj: number | null;
  et0_mm: number | null;
  is_forecast: boolean;
}

export interface AgroSummary {
  gdd: { sum: number; base_temp: number; from_date: string };
  et0_7d_mm: number;
  precip_7d_mm: number;
  water_balance_7d_mm: number;
  water_balance_30d_mm: number;
  notes: string[];
}

export type AdvisoryKind = 'frost_risk' | 'heat_stress' | 'spray_window';
export type Severity = 'info' | 'warning' | 'critical';

export interface Advisory {
  kind: AdvisoryKind;
  severity: Severity;
  date: string;
  message: string;
}

export type AlertState = 'open' | 'acked' | 'snoozed' | 'dismissed';

export interface Alert {
  id: string;
  parcel_id: string | null;
  kind: string;
  severity: Severity;
  title: string;
  message: string;
  data: Record<string, unknown>;
  state: AlertState;
  snoozed_until: string | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  /** Phase P. `GET /alerts` omits this field entirely (modules/alerts.rs is untouched);
   * `GET /plant-alerts` and `GET /plants/{id}/alerts` always carry it — see PlantAlert. */
  plant_id?: string | null;
}

export interface ObservationPhoto {
  path: string;
  taken_at?: string;
}

export interface Observation {
  id: string; // client-generated uuid
  parcel_id: string | null;
  note: string;
  tags: string[];
  photos: ObservationPhoto[];
  lon: number | null;
  lat: number | null;
  taken_at: string;
  updated_at: string;
  deleted: boolean;
  author_id?: string;
  author_name?: string;
  /** Phase P — optional per-plant pin. The sync protocol is unchanged; a client that omits
   * the field keeps working, and a plant_id outside the caller's org is stored as null. */
  plant_id?: string | null;
}

export interface SyncRequest {
  last_pulled_at: string | null;
  upserts: Observation[];
}

export interface SyncResponse {
  server_time: string;
  applied: string[];
  changes: Observation[];
}

export interface Meta {
  version: string;
  features: { imagery: boolean };
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase P — per-plant tier. Mirrors docs/API-PLANT.md 1:1 (that document is the
// frozen contract; where it and docs/PHASE-PLANT.md differ, API-PLANT.md wins).
// ─────────────────────────────────────────────────────────────────────────────

export type PlantUnit = 'tree' | 'vine' | 'row_segment' | 'bush';
export type PlantStatus = 'alive' | 'dead' | 'missing' | 'replanted' | 'removed';
export type PlantSource = 'detection' | 'manual' | 'import';
export type PlantMetric = 'ndvi' | 'ndre' | 'gndvi' | 'ndmi' | 'savi' | 'canopy_m2' | 'height_m';

export const PLANT_UNITS: PlantUnit[] = ['tree', 'vine', 'row_segment', 'bush'];
export const PLANT_STATUSES: PlantStatus[] = ['alive', 'dead', 'missing', 'replanted', 'removed'];
export const PLANT_METRICS: PlantMetric[] = [
  'ndvi',
  'ndre',
  'gndvi',
  'ndmi',
  'savi',
  'canopy_m2',
  'height_m',
];

export type CaptureSource = 'drone' | 'prebuilt' | 'demo';
export type CaptureStatus =
  | 'uploaded'
  | 'ortho'
  | 'detected'
  | 'registered'
  | 'extracted'
  | 'failed';
export type PipelineStage = 'sfm' | 'detect' | 'register' | 'extract';
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed';
export type CaptureAssetKind = 'raw' | 'ortho' | 'dsm';

/** Paginated envelope; `total` is the exact count of the filtered set. */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface Plant {
  id: string;
  parcel_id: string;
  block_id: string | null;
  block_name: string | null;
  row_id: string | null;
  row_name: string | null;
  unit_type: PlantUnit;
  /** plant point; segment midpoint for `row_segment` */
  lon: number;
  lat: number;
  /** delineated canopy footprint when one exists */
  crown: GeoJSONPolygon | null;
  label: string | null;
  row_index: number | null;
  col_index: number | null;
  variety: string | null;
  rootstock: string | null;
  planted_on: string | null;
  status: PlantStatus;
  external_ref: string | null;
  source: PlantSource;
  created_at: string;
  updated_at: string;
}

export interface PlantBlock {
  id: string;
  parcel_id: string;
  name: string;
  geometry: ParcelGeometry | null;
  notes: string | null;
  /** live COUNT(*) of non-`removed` plants */
  plant_count: number;
  created_at: string;
  updated_at: string;
}

export interface PlantRow {
  id: string;
  parcel_id: string;
  block_id: string | null;
  name: string;
  row_index: number | null;
  geometry: GeoJSONLineString | null;
  plant_count: number;
  created_at: string;
  updated_at: string;
}

/** reflectance band name → 1-based band index in `ortho.tif` */
export interface CaptureBands {
  red?: number;
  green?: number;
  blue?: number;
  rededge?: number;
  nir?: number;
  swir?: number;
}

export interface CaptureAsset {
  id: string;
  capture_id: string;
  kind: CaptureAssetKind;
  file_name: string;
  /** store-relative key (docs/API-PLANT.md §Storage layout) — never a path or a URL */
  path: string;
  bytes: number;
  content_type: string | null;
  checksum: string | null;
  created_at: string;
}

export interface PipelineJob {
  id: string;
  capture_id: string;
  stage: PipelineStage;
  state: JobState;
  attempts: number;
  max_attempts: number;
  run_after: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Capture {
  id: string;
  parcel_id: string;
  captured_at: string;
  source: CaptureSource;
  status: CaptureStatus;
  unit_type: PlantUnit;
  sensor: string | null;
  gsd_cm: number | null;
  bands: CaptureBands;
  pilot_name: string | null;
  operator_id: string | null;
  drone_model: string | null;
  flight_ref: string | null;
  notes: string | null;
  failed_stage: PipelineStage | null;
  error: string | null;
  /** [w, s, e, n] */
  bbox: [number, number, number, number] | null;
  plant_count: number;
  observation_count: number;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
  /** present only on GET /captures/{id} */
  assets?: CaptureAsset[];
  jobs?: PipelineJob[];
}

/** the cheap 5 s poll target while status ∉ {extracted, failed} */
export interface CaptureStatusInfo {
  capture_id: string;
  status: CaptureStatus;
  stage: PipelineStage | null;
  state: JobState | null;
  attempts: number;
  failed_stage: PipelineStage | null;
  error: string | null;
  plant_count: number;
  observation_count: number;
  asset_counts: { raw: number; ortho: number; dsm: number };
  updated_at: string;
}

export interface CaptureUploadResult {
  assets: CaptureAsset[];
  total_bytes: number;
}

export interface PlantObservation {
  observed_at: string;
  value: number;
  capture_id: string;
  /** 0..100 — fraction of usable pixels */
  quality: number | null;
  /** detector/extractor build stamp, e.g. `cv-chm-0.1.0` / `synth-0.1.0` (NFR-P-REPRO) */
  model_ver: string | null;
}

export interface PlantRanking {
  plant_id: string;
  label: string | null;
  lon: number;
  lat: number;
  block_id: string | null;
  row_id: string | null;
  status: PlantStatus;
  value: number;
  /** 0..1 on the parcel scale used by the vector tiles */
  normalized: number;
  /** 1-based within the full filtered set — survives paging */
  rank: number;
  /** 100·(value − block_median)/|block_median| */
  vs_block_pct: number | null;
  /** robust neighbour z; null when it could not be computed */
  neighbour_z: number | null;
}

export interface PlantOutlier {
  plant_id: string;
  label: string | null;
  lon: number;
  lat: number;
  block_id: string | null;
  row_id: string | null;
  status: PlantStatus;
  value: number;
  neighbour_median: number;
  neighbour_mad: number;
  neighbour_count: number;
  z: number;
  severity: Severity;
}

export type ReplantReason = 'missing' | 'dead' | 'vigor_collapse';

export interface ReplantEntry {
  plant_id: string;
  label: string | null;
  lon: number;
  lat: number;
  block_id: string | null;
  block_name: string | null;
  row_id: string | null;
  row_index: number | null;
  col_index: number | null;
  status: PlantStatus;
  reason: ReplantReason;
  last_seen_at: string | null;
  last_value: number | null;
  /** consecutive captures with no detection (plants.missing_streak) */
  captures_absent: number;
}

export interface PlantMetricSummary {
  observed_at: string;
  capture_id: string;
  mean: number;
  median: number | null;
  p10: number | null;
  p90: number | null;
  stddev: number | null;
  plant_count: number;
}

export interface PlantSummary {
  parcel_id: string;
  total: number;
  by_status: Record<PlantStatus, number>;
  unit_types: PlantUnit[];
  block_count: number;
  row_count: number;
  last_capture: { id: string; captured_at: string; status: CaptureStatus } | null;
  latest: Partial<Record<PlantMetric, PlantMetricSummary | null>>;
}

/** legend / colour-ramp domain for the plant tiles; all fields null when there is no capture yet */
export interface MetricScale {
  parcel_id: string;
  metric: PlantMetric;
  capture_id: string | null;
  observed_at: string | null;
  p5: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  plant_count: number;
}

export interface PlantRankingResponse {
  metric: PlantMetric;
  capture_id: string | null;
  observed_at: string | null;
  order: 'asc' | 'desc';
  page: Page<PlantRanking>;
}

export interface PlantOutliersResponse {
  metric: PlantMetric;
  capture_id: string | null;
  observed_at: string | null;
  k: number;
  radius_m: number;
  threshold: number;
  items: PlantOutlier[];
}

export interface PlantSeriesResponse {
  plant_id: string;
  metric: PlantMetric;
  series: PlantObservation[];
}

/** GET /plants/{id}/metrics/latest — every metric, null when never observed */
export type PlantLatestMetrics = Partial<Record<PlantMetric, PlantObservation | null>>;

/** one row of the plant-detail capture history table */
export interface PlantCaptureEntry {
  capture_id: string;
  captured_at: string;
  observed_at: string;
  quality: number | null;
  model_ver: string | null;
  metrics: Partial<Record<PlantMetric, number>>;
}

export interface PlantGrowthPoint {
  observed_at: string;
  capture_id: string;
  plant_count: number;
  mean: number;
  median: number | null;
  p10: number | null;
  p90: number | null;
  min: number | null;
  max: number | null;
}

export interface PlantGrowthResponse {
  metric: PlantMetric;
  points: PlantGrowthPoint[];
}

export interface PlantImportResult {
  created: number;
  updated: number;
  skipped: number;
  /** truncated to the first 20 */
  errors: { index: number; reason: string }[];
}

export type PlantAlertKind =
  | 'plant_vigor_outlier'
  | 'plant_missing'
  | 'plant_dead'
  | 'plant_drop';

/** an ordinary `alerts` row plus the plant's label — the existing lifecycle endpoints apply */
export interface PlantAlert extends Alert {
  plant_id: string | null;
  plant_label: string | null;
}

export interface PlantAlertDetectResult {
  scanned: number;
  created: number;
  updated: number;
}

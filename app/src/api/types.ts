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
  source: 'sentinel-2' | 'demo';
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

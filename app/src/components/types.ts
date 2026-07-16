// SPINE (read-only) — frozen component contracts (docs/AGENTS.md). Implementations replace the
// placeholder component files but MUST keep these exact props.
import type {
  Advisory,
  AgroSummary,
  Alert,
  GeoJSONPolygon,
  IndexName,
  IndexPoint,
  Parcel,
  WeatherDaily,
} from '../api/types';

export interface ParcelFeature {
  parcel: Parcel;
  /** fill color override (e.g. NDVI choropleth), CSS color string */
  color?: string;
}

export interface MapViewProps {
  parcels: ParcelFeature[];
  mode: 'view' | 'draw';
  onSelectParcel?: (parcelId: string) => void;
  onDrawComplete?: (geometry: GeoJSONPolygon) => void;
  /** [lon, lat, zoom?] */
  focus?: [number, number, number?];
  /** extra point markers (e.g. scouting observations) */
  markers?: { id: string; lon: number; lat: number; label?: string }[];
  /** XYZ raster overlay (index tiles) above base map, below parcel polygons */
  overlay?: {
    urlTemplate: string;
    opacity?: number;
    /** [w, s, e, n] — limits tile requests */
    bounds?: [number, number, number, number];
  };
  height?: number;
}

export interface IndexChartProps {
  series: IndexPoint[];
  index: IndexName;
  height?: number;
}

export interface WeatherPanelProps {
  daily: WeatherDaily[];
  agro?: AgroSummary;
  advisories?: Advisory[];
}

export type AlertAction = 'ack' | 'dismiss' | 'snooze';

export interface AlertListProps {
  alerts: Alert[];
  onAction: (id: string, action: AlertAction) => void;
  parcelNames?: Record<string, string>;
  /** when set, cards with a parcel show an "Open parcel →" link */
  onOpenParcel?: (parcelId: string) => void;
}

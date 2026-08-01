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
  ParcelGeometry,
  PlantMetric,
  WeatherDaily,
} from '../api/types';

export interface ParcelFeature {
  parcel: Parcel;
  /** fill color override (e.g. NDVI choropleth), CSS color string */
  color?: string;
}

/** One cadastral parcel candidate on the onboarding overlay (FR-0-010b). */
export interface CadastreMapFeature {
  /** national cadastral reference — the feature's identity on the wire */
  ref: string;
  geometry: ParcelGeometry;
  /** already onboarded as a field in this org (rendered muted, not selectable) */
  existing: boolean;
  /** pre-localized tooltip text (i18n stays in React, not in the map document) */
  tooltip: string;
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
  /** cadastral candidates overlay; refs in `selected` render highlighted */
  cadastre?: { features: CadastreMapFeature[]; selected: string[] };
  /** tap on a non-existing cadastral candidate */
  onCadastreTap?: (ref: string) => void;
  /** fires after every pan/zoom settles — feeds viewport cadastre detection */
  onViewportChange?: (view: { bbox: [number, number, number, number]; zoom: number }) => void;
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

/**
 * FROZEN (docs/API-PLANT.md §App-side contracts). A parcel can hold tens of thousands of plants,
 * so the map consumes an MVT **tile URL template**, never an array of plants. Implementation is
 * MapLibre GL JS loaded from CDN inside the existing shared-HTML WebView (native) / iframe srcDoc
 * (web) bridge — same architecture and JSON postMessage protocol as `map/mapHtml.ts`. No new npm
 * package, no native module, and a type-only `PlantMap.d.ts` shim so Metro picks `.web`/`.native`.
 */
export interface PlantMapProps {
  parcelId: string;
  /** MVT template containing {z}/{x}/{y}, already carrying ?metric=&capture=&token= */
  tileUrlTemplate: string;
  /** parcel outline drawn under the plant layer */
  parcelGeometry?: ParcelGeometry;
  metric: PlantMetric;
  /** colour-ramp domain from GET /parcels/{id}/plants/metric-scale */
  scale?: { p5: number; p95: number };
  /** [lon, lat, zoom?] */
  focus?: [number, number, number?];
  selectedPlantId?: string | null;
  onSelectPlant?: (plantId: string) => void;
  height?: number;
}

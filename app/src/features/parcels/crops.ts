// OWNER: fe-map — crop metadata, NDVI choropleth scale, and small parcel helpers shared by the
// map tab and parcel screens.
import type { ComponentProps } from 'react';

import type Ionicons from '@expo/vector-icons/Ionicons';
import type { Parcel, ParcelGeometry } from '@/api/types';

export type IoniconName = ComponentProps<typeof Ionicons>['name'];

export type CropKey = 'vine' | 'olive' | 'tomato' | 'wheat' | 'maize' | 'other';

// value + i18n label key + glyph. Order drives the chip row in parcel/new + edit. Crop value
// labels live under the top-level `crop.*` namespace (kept separate from the `parcel.crop` field
// label so i18next never sees a key that is both a leaf and a prefix).
export const CROP_OPTIONS: { value: CropKey; labelKey: string; icon: IoniconName }[] = [
  { value: 'vine', labelKey: 'crop.vine', icon: 'wine' },
  { value: 'olive', labelKey: 'crop.olive', icon: 'leaf' },
  { value: 'tomato', labelKey: 'crop.tomato', icon: 'nutrition' },
  { value: 'wheat', labelKey: 'crop.wheat', icon: 'flower' },
  { value: 'maize', labelKey: 'crop.maize', icon: 'leaf' },
  { value: 'other', labelKey: 'crop.other', icon: 'ellipse' },
];

export function cropLabelKey(crop: string | null | undefined): string {
  const opt = CROP_OPTIONS.find((c) => c.value === crop);
  return opt ? opt.labelKey : 'crop.other';
}

export function cropIcon(crop: string | null | undefined): IoniconName {
  const opt = CROP_OPTIONS.find((c) => c.value === crop);
  return opt ? opt.icon : 'ellipse';
}

// Fill shown when a parcel has no NDVI reading yet.
export const NEUTRAL_FILL = '#B6BAB2';

// Latest-NDVI choropleth (docs/API.md dashboard scale). null → neutral grey.
export function ndviColor(mean: number | null | undefined): string {
  if (mean == null) return NEUTRAL_FILL;
  if (mean < 0.3) return '#A5432B';
  if (mean < 0.5) return '#C7A34E';
  if (mean < 0.65) return '#B8BF5C';
  return '#4F8F4A';
}

export function formatArea(ha: number | null | undefined): string {
  if (ha == null) return '—';
  return `${ha.toFixed(2)} ha`;
}

// Simple client-side YYYY-MM-DD validation for the planting-date text field.
export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Minimal Parcel used to preview a freshly drawn/imported geometry on the MapView (only
// id/name/geometry/color are read by the map; the rest satisfy the type).
export function draftParcel(geometry: ParcelGeometry, name: string): Parcel {
  return {
    id: 'draft',
    farm_id: '',
    name: name || '',
    geometry,
    area_ha: 0,
    centroid: { lon: 0, lat: 0 },
    bbox: [0, 0, 0, 0],
    crop: null,
    variety: null,
    planting_date: null,
    season_year: null,
    archived: false,
    created_at: '',
  };
}

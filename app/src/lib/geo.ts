// OWNER: capture-observe — pure geometry helpers for the field capture flow (docs/UX-REVAMP.md).
// Turns a raw GPS fix into something the farmer recognizes ("inside Uliveto Vecchio",
// "320 m from Orto 3"). Defensive by design: malformed input returns false/null, never throws.
import type { Parcel, ParcelGeometry } from '@/api/types';

const EARTH_RADIUS_M = 6_371_000;

function isNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Ray casting over one linear ring (`[lon, lat][]`, closing vertex optional).
 * Points exactly on an edge may land on either side — fine for a "which field am I in" hint.
 */
function ringContains(ring: readonly number[][], lon: number, lat: number): boolean {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]?.[0];
    const yi = ring[i]?.[1];
    const xj = ring[j]?.[0];
    const yj = ring[j]?.[1];
    if (!isNum(xi) || !isNum(yi) || !isNum(xj) || !isNum(yj)) continue;
    const crosses =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * Even-odd rule across all rings of one polygon: crossing the outer ring puts the point in,
 * crossing a hole ring takes it back out.
 */
function polygonContains(rings: readonly number[][][], lon: number, lat: number): boolean {
  if (!Array.isArray(rings)) return false;
  let inside = false;
  for (const ring of rings) {
    if (ringContains(ring, lon, lat)) inside = !inside;
  }
  return inside;
}

/**
 * True when the point falls inside the GeoJSON `Polygon`/`MultiPolygon` (holes respected via
 * the even-odd rule). Any malformed or missing geometry is simply "not inside".
 *
 * @param lon longitude in degrees (GeoJSON x)
 * @param lat latitude in degrees (GeoJSON y)
 */
export function pointInPolygon(
  lon: number,
  lat: number,
  geometry: ParcelGeometry | null | undefined,
): boolean {
  if (!isNum(lon) || !isNum(lat) || geometry == null) return false;
  if (geometry.type === 'Polygon') return polygonContains(geometry.coordinates, lon, lat);
  if (geometry.type === 'MultiPolygon') {
    if (!Array.isArray(geometry.coordinates)) return false;
    return geometry.coordinates.some((poly) => polygonContains(poly, lon, lat));
  }
  return false;
}

/** Great-circle (haversine) distance between two lon/lat points, in meters. NaN inputs → Infinity. */
export function haversineM(aLon: number, aLat: number, bLon: number, bLat: number): number {
  if (!isNum(aLon) || !isNum(aLat) || !isNum(bLon) || !isNum(bLat)) return Infinity;
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface NearestParcelMatch {
  parcel: Parcel;
  /** centroid distance in meters (0 does NOT mean inside — pair with pointInPolygon) */
  distanceM: number;
}

/**
 * Closest parcel by centroid haversine distance, or null when the list is empty or no parcel
 * carries a usable centroid. Callers decide what "near enough" means.
 */
export function nearestParcel(
  parcels: readonly Parcel[] | null | undefined,
  lon: number,
  lat: number,
): NearestParcelMatch | null {
  if (!Array.isArray(parcels) || parcels.length === 0) return null;
  let best: NearestParcelMatch | null = null;
  for (const parcel of parcels) {
    const c = parcel?.centroid;
    if (!c || !isNum(c.lon) || !isNum(c.lat)) continue;
    const distanceM = haversineM(lon, lat, c.lon, c.lat);
    if (!Number.isFinite(distanceM)) continue;
    if (best == null || distanceM < best.distanceM) best = { parcel, distanceM };
  }
  return best;
}

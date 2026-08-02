// OWNER: capture-observe — pure geometry helpers for the field capture flow (docs/UX-REVAMP.md).
// Turns a raw GPS fix into something the farmer recognizes ("inside Uliveto Vecchio",
// "320 m from Orto 3"). Defensive by design: malformed input returns false/null, never throws.
import type { CadastralParcel, Parcel, ParcelGeometry } from '@/api/types';

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

/** Move a WGS84 point by a short distance and compass bearing. Accurate enough for the
 * 5–200 m onboarding ray; unlike a degrees-per-meter shortcut it behaves correctly across Italy. */
export function destinationPoint(
  lon: number,
  lat: number,
  bearingDeg: number,
  distanceM: number,
): [number, number] {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const angular = distanceM / EARTH_RADIUS_M;
  const bearing = bearingDeg * toRad;
  const lat1 = lat * toRad;
  const lon1 = lon * toRad;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );
  return [(((lon2 * toDeg + 540) % 360) - 180), lat2 * toDeg];
}

function geometryCenter(geometry: ParcelGeometry): [number, number] | null {
  const polygon = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates[0];
  const ring = polygon?.[0];
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const point of ring) {
    const [lon, lat] = point;
    if (!isNum(lon) || !isNum(lat)) continue;
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null;
  return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
}

function bearingTo(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((bLon - aLon) * toRad) * Math.cos(bLat * toRad);
  const x =
    Math.cos(aLat * toRad) * Math.sin(bLat * toRad) -
    Math.sin(aLat * toRad) * Math.cos(bLat * toRad) *
      Math.cos((bLon - aLon) * toRad);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function headingDifference(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/**
 * Pick the cadastral parcel the phone is inside or pointing toward. A short ray is sampled first
 * so standing on a lane and facing a field selects that outline. A conservative centroid fallback
 * handles narrow/irregular parcels without ever choosing something behind the user.
 */
export function cadastralParcelInDirection(
  candidates: readonly CadastralParcel[] | null | undefined,
  lon: number,
  lat: number,
  headingDeg: number | null,
): CadastralParcel | null {
  const available = (candidates ?? []).filter(
    (candidate) => !candidate.properties.existing_parcel_id,
  );
  const containing = available.find((candidate) => pointInPolygon(lon, lat, candidate.geometry));
  if (containing) return containing;
  if (!isNum(headingDeg)) return null;

  for (const distanceM of [8, 15, 25, 40, 65, 100, 150]) {
    const [rayLon, rayLat] = destinationPoint(lon, lat, headingDeg, distanceM);
    const hit = available.find((candidate) =>
      pointInPolygon(rayLon, rayLat, candidate.geometry),
    );
    if (hit) return hit;
  }

  let best: { candidate: CadastralParcel; score: number } | null = null;
  for (const candidate of available) {
    const center = geometryCenter(candidate.geometry);
    if (!center) continue;
    const distanceM = haversineM(lon, lat, center[0], center[1]);
    if (distanceM > 220) continue;
    const angle = headingDifference(bearingTo(lon, lat, center[0], center[1]), headingDeg);
    if (angle > 45) continue;
    const score = distanceM + angle * 3;
    if (!best || score < best.score) best = { candidate, score };
  }
  return best?.candidate ?? null;
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

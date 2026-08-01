// OWNER: parcel-flow — forward geocoding for the "find my fields" fallback in parcel/new.
//
// DEV-TIER USAGE of the public Nominatim instance, per the OSMF usage policy
// (https://operations.osmfoundation.org/policies/nominatim/): identify the app via
// User-Agent, at most 1 request per second (module-level throttle below), and no
// per-keystroke autocomplete — callers search on explicit submit only.
// This module is the single swap point for a self-hosted geocoder (Photon / Pelias /
// Nominatim mirror) before any real traffic: keep the searchPlaces() signature, change
// the URL + response mapping.

export interface GeocodeResult {
  label: string;
  lon: number;
  lat: number;
}

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const MIN_INTERVAL_MS = 1000; // Nominatim policy: max 1 req/s
const LIMIT = 5;

let lastRequestAt = 0;
let inflight: AbortController | null = null;

function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

/** True when an error came from a superseded search (a newer query aborted it). */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/**
 * Search Italian places by free text. A new call aborts the previous one; requests are
 * spaced ≥ 1 s apart. Throws an AbortError (see isAbortError) when superseded — callers
 * should silently ignore that case.
 */
export async function searchPlaces(q: string): Promise<GeocodeResult[]> {
  const query = q.trim();
  if (!query) return [];

  inflight?.abort();
  const ac = new AbortController();
  inflight = ac;

  const wait = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - Date.now());
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  if (ac.signal.aborted) throw abortError();
  lastRequestAt = Date.now();

  const url = `${ENDPOINT}?format=json&countrycodes=it&limit=${LIMIT}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    signal: ac.signal,
    // Browsers strip User-Agent (forbidden header); native fetch sends it as required
    // by the Nominatim policy.
    headers: { 'User-Agent': 'Arvo/0.1 (dev)', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`geocode_${res.status}`);

  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) return [];
  const out: GeocodeResult[] = [];
  for (const row of json) {
    const r = row as { display_name?: unknown; lon?: unknown; lat?: unknown };
    const label = typeof r.display_name === 'string' ? r.display_name : '';
    const lon = Number(r.lon);
    const lat = Number(r.lat);
    if (!label || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    out.push({ label, lon, lat });
  }
  return out;
}

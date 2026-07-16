// OWNER: fe-scouting — offline-first observation store + sync engine.
// AsyncStorage-backed store; POST /observations/sync with LWW merge; photos uploaded separately
// after their observation is applied server-side. Consumed by screens via a module-level
// subscribe/snapshot pattern (see ./hooks.ts) — no dependency on _layout.
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { AppState, Platform } from 'react-native';

import { API_URL, api, getAuthToken } from '@/api/client';
import type { Observation, SyncRequest, SyncResponse } from '@/api/types';

export interface PhotoQueueEntry {
  obsId: string;
  localUri: string;
  name: string;
  mime: string;
}

interface Store {
  observations: Record<string, Observation>;
  outbox: string[]; // observation ids awaiting push
  photoQueue: PhotoQueueEntry[]; // photos awaiting upload
  lastPulledAt: string | null;
}

const KEY = 'arvo.scouting.store';
const EMPTY: Store = { observations: {}, outbox: [], photoQueue: [], lastPulledAt: null };

// --- persistence + serialized mutation ------------------------------------------------------

let cache: Store | null = null;
let loadPromise: Promise<Store> | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

function normalize(parsed: unknown): Store {
  const p = (parsed ?? {}) as Partial<Store>;
  return {
    observations: p.observations ?? {},
    outbox: Array.isArray(p.outbox) ? p.outbox : [],
    photoQueue: Array.isArray(p.photoQueue) ? p.photoQueue : [],
    lastPulledAt: p.lastPulledAt ?? null,
  };
}

async function loadStore(): Promise<Store> {
  if (cache) return cache;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await AsyncStorage.getItem(KEY);
        cache = raw ? normalize(JSON.parse(raw)) : { ...EMPTY };
      } catch {
        cache = { ...EMPTY };
      }
      rebuildSnapshot();
      return cache;
    })();
  }
  return loadPromise;
}

// Serialize every read-modify-write so concurrent mutations never lose updates.
async function mutate(fn: (s: Store) => Store): Promise<Store> {
  const run = async (): Promise<Store> => {
    const cur = await loadStore();
    const next = fn(cur);
    cache = next;
    try {
      await AsyncStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // best-effort persistence; in-memory cache still advances
    }
    rebuildSnapshot();
    notify();
    return next;
  };
  const p = writeChain.then(run, run);
  writeChain = p.catch(() => {});
  return p;
}

// --- reactive snapshot ----------------------------------------------------------------------

export interface ScoutingSnapshot {
  observations: Observation[]; // desc by taken_at, excludes tombstones
  photoThumbByObs: Record<string, string>; // obsId -> first pending local uri
  outbox: string[];
  pendingCount: number;
  syncing: boolean;
  lastSync: string | null;
  error: string | null;
}

let syncing = false;
let lastError: string | null = null;

let snapshot: ScoutingSnapshot = {
  observations: [],
  photoThumbByObs: {},
  outbox: [],
  pendingCount: 0,
  syncing: false,
  lastSync: null,
  error: null,
};

function epoch(ts: string): number {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? 0 : n;
}

function rebuildSnapshot(): void {
  const s = cache ?? EMPTY;
  const observations = Object.values(s.observations)
    .filter((o) => !o.deleted)
    .sort((a, b) => epoch(b.taken_at) - epoch(a.taken_at));
  const photoThumbByObs: Record<string, string> = {};
  for (const p of s.photoQueue) {
    if (!photoThumbByObs[p.obsId]) photoThumbByObs[p.obsId] = p.localUri;
  }
  snapshot = {
    observations,
    photoThumbByObs,
    outbox: s.outbox,
    pendingCount: s.outbox.length + s.photoQueue.length,
    syncing,
    lastSync: s.lastPulledAt,
    error: lastError,
  };
}

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): ScoutingSnapshot {
  return snapshot;
}

function setSyncing(v: boolean): void {
  if (syncing === v) return;
  syncing = v;
  rebuildSnapshot();
  notify();
}

function setError(e: string | null): void {
  if (lastError === e) return;
  lastError = e;
  rebuildSnapshot();
  notify();
}

// --- local mutations ------------------------------------------------------------------------

/** Write the full row (client updated_at = now) to the store and enqueue it for push. */
export async function upsertLocal(obs: Observation): Promise<void> {
  const now = new Date().toISOString();
  await mutate((s) => ({
    ...s,
    observations: { ...s.observations, [obs.id]: { ...obs, updated_at: now } },
    outbox: s.outbox.includes(obs.id) ? s.outbox : [...s.outbox, obs.id],
  }));
  void sync();
}

/** Tombstone an observation (deleted:true) and enqueue for push. */
export async function markDeleted(id: string): Promise<void> {
  const now = new Date().toISOString();
  await mutate((s) => {
    const existing = s.observations[id];
    if (!existing) return s;
    return {
      ...s,
      observations: { ...s.observations, [id]: { ...existing, deleted: true, updated_at: now } },
      outbox: s.outbox.includes(id) ? s.outbox : [...s.outbox, id],
    };
  });
  void sync();
}

/** Queue a photo for multipart upload once its observation is applied server-side. */
export async function queuePhoto(entry: PhotoQueueEntry): Promise<void> {
  await mutate((s) => ({ ...s, photoQueue: [...s.photoQueue, entry] }));
  void sync();
}

// --- sync -----------------------------------------------------------------------------------

function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const m = e instanceof Error ? e.message : String(e);
  return /network request failed|failed to fetch|network error/i.test(m);
}

async function uploadPhoto(obsId: string, entry: PhotoQueueEntry): Promise<{ path: string }> {
  const form = new FormData();
  if (Platform.OS === 'web') {
    const resp = await fetch(entry.localUri);
    const blob = await resp.blob();
    form.append('file', blob, entry.name);
  } else {
    // React Native multipart file part
    form.append('file', { uri: entry.localUri, name: entry.name, type: entry.mime } as unknown as Blob);
  }
  const token = getAuthToken();
  const res = await fetch(`${API_URL}/api/v1/observations/${obsId}/photos`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (!res.ok) throw new Error(`photo_upload_${res.status}`);
  return (await res.json()) as { path: string };
}

async function drainPhotos(): Promise<void> {
  const s = await loadStore();
  // Only upload photos whose observation the server already knows (not in outbox) and isn't a tombstone.
  const pending = s.photoQueue.filter(
    (p) =>
      !s.outbox.includes(p.obsId) &&
      s.observations[p.obsId] !== undefined &&
      !s.observations[p.obsId].deleted,
  );
  for (const entry of pending) {
    let uploaded: { path: string };
    try {
      uploaded = await uploadPhoto(entry.obsId, entry);
    } catch {
      break; // transient/network — leave queued, retry next sync
    }
    await mutate((st) => {
      const obs = st.observations[entry.obsId];
      const observations = obs
        ? {
            ...st.observations,
            [entry.obsId]: {
              ...obs,
              photos: [...obs.photos, { path: uploaded.path, taken_at: new Date().toISOString() }],
            },
          }
        : st.observations;
      return {
        ...st,
        observations,
        photoQueue: st.photoQueue.filter(
          (q) => !(q.obsId === entry.obsId && q.localUri === entry.localUri),
        ),
      };
    });
  }
}

let mutexHeld = false;

/** Push the outbox, merge server changes (LWW), then drain the photo queue. Mutex-guarded. */
export async function sync(): Promise<void> {
  if (mutexHeld) return;
  mutexHeld = true; // acquire synchronously, before any await, so the guard actually holds
  let began = false;
  try {
    // Connectivity gate: skip cleanly when explicitly offline (no spurious errors/spinner).
    try {
      const net = await NetInfo.fetch();
      if (net.isConnected === false) return;
    } catch {
      // NetInfo unavailable — proceed and let the request decide.
    }
    began = true;
    setSyncing(true);
    setError(null);
    const s = await loadStore();
    const upserts = s.outbox
      .map((id) => s.observations[id])
      .filter((o): o is Observation => o !== undefined);
    const req: SyncRequest = { last_pulled_at: s.lastPulledAt, upserts };
    const res = await api.post<SyncResponse>('/observations/sync', req);

    const appliedSet = new Set(res.applied);
    await mutate((st) => {
      const observations = { ...st.observations };
      let outbox = st.outbox.filter((id) => !appliedSet.has(id));
      for (const ch of res.changes) {
        const local = observations[ch.id];
        if (outbox.includes(ch.id)) {
          // Row still pending: never clobber it with older server data. If the server copy is
          // strictly newer, LWW says it wins and our pending edit is superseded.
          if (local && epoch(ch.updated_at) > epoch(local.updated_at)) {
            observations[ch.id] = ch;
            outbox = outbox.filter((id) => id !== ch.id);
          }
        } else if (!local || epoch(ch.updated_at) >= epoch(local.updated_at)) {
          observations[ch.id] = ch;
        }
      }
      return { ...st, observations, outbox, lastPulledAt: res.server_time };
    });

    await drainPhotos();
  } catch (e) {
    if (!isNetworkError(e)) setError(e instanceof Error ? e.message : 'sync_failed');
  } finally {
    mutexHeld = false;
    if (began) setSyncing(false);
  }
}

// --- lifecycle triggers ---------------------------------------------------------------------

let started = false;

/** Idempotently attach reconnect / foreground sync triggers. Safe to call from any screen mount. */
export function ensureStarted(): void {
  if (started) return;
  started = true;
  void loadStore();
  let wasConnected: boolean | null = null;
  NetInfo.addEventListener((state) => {
    if (state.isConnected === true && wasConnected !== true) void sync();
    wasConnected = state.isConnected;
  });
  AppState.addEventListener('change', (next) => {
    if (next === 'active') void sync();
  });
}

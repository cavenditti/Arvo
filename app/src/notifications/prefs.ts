// OWNER: push-app — notification preferences, AsyncStorage-backed with a tiny external store
// so every mounted screen sees the same values. NOTE: `severeOnly` and `dailyDigest` are
// STORED ONLY for now — the backend does not act on them yet; UI must present them as
// "coming soon", never as working switches (docs/UX-REVAMP.md §push-app).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

export interface PushPrefs {
  pushEnabled: boolean;
  severeOnly: boolean;
  dailyDigest: boolean;
}

const STORAGE_KEY = 'arvo.push.prefs';

export const DEFAULT_PUSH_PREFS: PushPrefs = {
  pushEnabled: false,
  severeOnly: false,
  dailyDigest: false,
};

interface PrefsState {
  prefs: PushPrefs;
  /** false until the stored value has been read once (defaults shown meanwhile). */
  ready: boolean;
}

let state: PrefsState = { prefs: DEFAULT_PUSH_PREFS, ready: false };
const listeners = new Set<() => void>();
let loadPromise: Promise<void> | null = null;

function emit(next: PrefsState): void {
  state = next;
  for (const listener of listeners) listener();
}

function sanitize(raw: unknown): PushPrefs {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    pushEnabled: obj.pushEnabled === true,
    severeOnly: obj.severeOnly === true,
    dailyDigest: obj.dailyDigest === true,
  };
}

function loadOnce(): Promise<void> {
  loadPromise ??= (async () => {
    let prefs = DEFAULT_PUSH_PREFS;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw != null) prefs = sanitize(JSON.parse(raw));
    } catch {
      // Unreadable prefs — fall back to defaults rather than break Settings.
    }
    // A set() may have landed while we were reading; never clobber it with stale disk state.
    if (!state.ready) emit({ prefs, ready: true });
  })();
  return loadPromise;
}

export async function getPushPrefs(): Promise<PushPrefs> {
  await loadOnce();
  return state.prefs;
}

export async function setPushPrefs(patch: Partial<PushPrefs>): Promise<PushPrefs> {
  if (!state.ready) await loadOnce();
  const next = { ...state.prefs, ...patch };
  emit({ prefs: next, ready: true });
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Persist is best-effort; in-memory state already updated for this session.
  }
  return next;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

const getSnapshot = (): PrefsState => state;

/** Reactive prefs for screens: `{ prefs, ready, update }` — update() persists in background. */
export function usePushPrefs(): PrefsState & { update(patch: Partial<PushPrefs>): void } {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void loadOnce();
  }, []);
  return useMemo(
    () => ({
      ...snapshot,
      update: (patch: Partial<PushPrefs>) => {
        void setPushPrefs(patch);
      },
    }),
    [snapshot],
  );
}

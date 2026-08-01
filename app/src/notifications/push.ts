// OWNER: push-app — Expo push client (docs/UX-REVAMP.md §Frozen module contracts).
// setupNotifications() wires the foreground presentation handler once; usePushRegistration()
// performs the system permission request + Expo token registration AFTER the caller has primed
// the user (PrimeCard first — this hook never explains, it only asks the OS and the backend).
// Every path is defensive: nothing here may throw on web, in Expo Go, or on a simulator.
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { api } from '@/api/client';

export type PushRegistrationStatus = 'idle' | 'granted' | 'denied' | 'unavailable';

/** Last token successfully POSTed to /devices — re-registration is a cheap string compare. */
const LAST_SENT_TOKEN_KEY = 'arvo.push.lastSentToken';

let handlerInstalled = false;

/**
 * Idempotent notification wiring — safe to call from any screen, on any platform.
 * Foreground notifications are shown as banners for everything the server sends:
 * "banner+sound for severe only" is a future server-side concern, not a client filter.
 */
export function setupNotifications(): void {
  if (handlerInstalled || Platform.OS === 'web') return;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
    // iOS notification categories: deliberately none this run — the backend sends no
    // categoryIdentifier and no response routing exists yet, so actions would be dead UI.
    handlerInstalled = true;
  } catch {
    // Native module unavailable — notifications are optional, never crash the app.
  }
}

function projectIdFromConfig(): string | null {
  const projectId: unknown = Constants.expoConfig?.extra?.eas?.projectId;
  return typeof projectId === 'string' && projectId.length > 0 ? projectId : null;
}

/** True when remote push can work here at all (real device, dev/store build, EAS project set). */
function pushCapable(): boolean {
  if (Platform.OS === 'web') return false;
  // Expo Go (SDK 53+) has no remote-push support — degrade without ever asking the OS.
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return false;
  if (!Device.isDevice) return false; // simulator/emulator
  return projectIdFromConfig() != null;
}

/**
 * Has the system notifications dialog already been shown and resolved on this device?
 * Settings uses this to decide between the full PrimeCard (never primed) and the plain toggle.
 */
export async function isPushPermissionDetermined(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const perm = await Notifications.getPermissionsAsync();
    return perm.status !== 'undetermined';
  } catch {
    return false;
  }
}

async function sendTokenIfChanged(token: string): Promise<void> {
  let lastSent: string | null = null;
  try {
    lastSent = await AsyncStorage.getItem(LAST_SENT_TOKEN_KEY);
  } catch {
    // Unreadable memo — treat as never sent and re-upsert (backend upserts by token).
  }
  if (lastSent === token) return;
  await api.post('/devices', { platform: Platform.OS, token });
  try {
    await AsyncStorage.setItem(LAST_SENT_TOKEN_KEY, token);
  } catch {
    // Memo write failed — worst case we re-POST the same token next run (harmless upsert).
  }
}

/** Never rejects: capability check → permission request → token fetch → device upsert. */
async function registerAsync(): Promise<Exclude<PushRegistrationStatus, 'idle'>> {
  if (!pushCapable()) return 'unavailable';
  try {
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) {
      // The caller has already shown the PrimeCard — this is the real system dialog.
      perm = await Notifications.requestPermissionsAsync();
    }
    if (!perm.granted) return 'denied';

    const projectId = projectIdFromConfig();
    if (projectId == null) return 'unavailable';
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    try {
      await sendTokenIfChanged(token);
    } catch {
      // Offline or backend hiccup: OS permission is granted; the token is re-sent next time
      // registration runs because LAST_SENT_TOKEN_KEY is only written on success.
    }
    return 'granted';
  } catch {
    // Token service / native module failure — treat as unavailable, never crash Settings.
    return 'unavailable';
  }
}

/**
 * Best-effort deregistration for the Settings toggle turning OFF. If the DELETE fails
 * (offline), the memo is kept so a later toggle-off retries and a re-enable skips the POST.
 */
export async function unregisterPush(): Promise<void> {
  try {
    const lastSent = await AsyncStorage.getItem(LAST_SENT_TOKEN_KEY);
    if (lastSent != null && lastSent.length > 0) {
      await api.del(`/devices/${encodeURIComponent(lastSent)}`);
    }
    await AsyncStorage.removeItem(LAST_SENT_TOKEN_KEY);
  } catch {
    // Offline: the backend row goes stale and is refreshed on the next registration.
  }
}

/**
 * Frozen contract (docs/UX-REVAMP.md): drives the whole registration flow while `enabled`.
 * The caller shows the PrimeCard BEFORE flipping `enabled` to true — flipping it is consent
 * to show the system dialog. Status meanings:
 * - 'idle'        — not enabled (or turned off)
 * - 'granted'     — OS permission granted; token registered (or queued for re-send)
 * - 'denied'      — OS permission refused; the phone blocks alerts
 * - 'unavailable' — push cannot work here (web, Expo Go, simulator, missing EAS projectId)
 */
export function usePushRegistration(enabled: boolean): { status: PushRegistrationStatus } {
  // Outcome of the most recent registration run; 'idle' is derived from `enabled` at render
  // time so disabling never needs a setState-in-effect.
  const [lastResult, setLastResult] = useState<PushRegistrationStatus>('idle');
  // Monotonic run id: only the latest run may commit its result (enable/disable races).
  const runRef = useRef(0);

  useEffect(() => {
    // Guarantee the foreground handler exists before any notification can arrive.
    setupNotifications();
    const run = ++runRef.current;
    if (!enabled) return;
    void registerAsync().then((next) => {
      if (runRef.current === run) setLastResult(next);
    });
  }, [enabled]);

  return { status: enabled ? lastResult : 'idle' };
}

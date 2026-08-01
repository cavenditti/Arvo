// OWNER: foundation-ui — tactile feedback (docs/UX-REVAMP.md frozen contract).
// Thin, safe wrappers over expo-haptics: silent no-ops on web, never throw anywhere.
// Use sparingly — selection for taps that change state, notification kinds for outcomes.
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

function fire(trigger: () => Promise<void>): void {
  if (Platform.OS === 'web') return;
  try {
    trigger().catch(() => {
      // Haptics engine unavailable (simulator, low power) — feedback is optional.
    });
  } catch {
    // Native module missing — never let feedback break an interaction.
  }
}

/** Light tick for a registered selection/tap. */
export function selection(): void {
  fire(() => Haptics.selectionAsync());
}

/** Positive outcome (saved, synced, confirmed). */
export function success(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

/** Cautionary outcome (partial save, needs attention). */
export function warning(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
}

/** Failed outcome (save failed, invalid input). */
export function error(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
}

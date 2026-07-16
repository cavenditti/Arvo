// OWNER: fe-shell — may refine values; other agents import tokens, never hardcode colors.
// "Campo" design language (see ui-mock.zip): ivory paper surfaces, forest-green ink actions,
// terracotta for attention, amber for watch, monospace micro-labels for data/meta text.
import { Platform } from 'react-native';

export const colors = {
  primary: '#234B34', // forest green — actions, active states
  primaryDark: '#1F4430',
  primarySoft: '#E9EFE9', // tinted green surface (active nav, healthy chip)
  accent: '#A5432B', // terracotta
  bg: '#F2F1EC', // ivory paper
  card: '#FBFAF7',
  cardAlt: '#F6F5F2', // inset panels on top of card
  text: '#1B1E1A',
  textMuted: '#5C625C',
  textFaint: '#8A8F86',
  border: '#E4E1D7',
  borderSoft: '#EDECE7',
  danger: '#A5432B',
  warning: '#9A6A1E',
  info: '#5B8F8A',
  success: '#3F7D45',
  onPrimary: '#F6F5F2',
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };

// Monospace accent font for data values, micro-labels, and meta rows (IBM Plex Mono in the
// mock; closest system font per platform keeps us dependency-free).
export const fonts = {
  mono: Platform.select({
    ios: 'Menlo',
    android: 'monospace',
    default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  }) as string,
};

export const severityColor: Record<string, string> = {
  info: colors.info,
  warning: colors.warning,
  critical: colors.danger,
};

// Severity tag/gradient tints (mock: cards fade from this toward the card color — no left borders).
export const severityTint: Record<string, { fg: string; bg: string }> = {
  critical: { fg: '#A5432B', bg: '#F7E7E2' },
  warning: { fg: '#9A6A1E', bg: '#F6EFDD' },
  info: { fg: '#5B8F8A', bg: '#E5EEED' },
};

// Parcel/alert health status: chip tint + text color pairs from the mock.
export type Status = 'healthy' | 'watch' | 'attention';
export const statusColors: Record<Status, { fg: string; bg: string }> = {
  healthy: { fg: '#3F7D45', bg: '#E9EFE9' },
  watch: { fg: '#9A6A1E', bg: '#F6EFDD' },
  attention: { fg: '#A5432B', bg: '#F7E7E2' },
};

/** Worst open-alert severity → parcel status (no alert = healthy). */
export function statusForSeverity(severity?: string | null): Status {
  if (severity === 'critical') return 'attention';
  if (severity === 'warning') return 'watch';
  return 'healthy';
}

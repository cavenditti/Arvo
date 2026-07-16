// OWNER: fe-shell — Terra design language tokens (docs/DESIGN.md). Other code imports tokens,
// never hardcodes colors/fonts. Extend here first when a screen needs something new.

export const colors = {
  primary: '#234B34', // forest green — actions, active states
  primaryDark: '#1F4430',
  primarySoft: '#E9EFE9', // tinted green surface (active nav, healthy chip)
  accent: '#A5432B', // clay
  bg: '#F2F1EC', // paper
  card: '#FBFAF7',
  cardAlt: '#F6F5F2', // inset panels on top of card
  text: '#1B1E1A',
  textMuted: '#5C625C',
  textFaint: '#8A8F86',
  border: '#E4E1D7',
  borderSoft: '#EDECE7',
  danger: '#A5432B',
  warning: '#9A6A1E', // straw
  info: '#5B8F8A', // eucalyptus
  success: '#3F7D45', // leaf
  onPrimary: '#F6F5F2',
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
export const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 };

// Terra type voices (loaded in app/_layout): Fraunces = display, Manrope = body,
// IBM Plex Mono = data. NEVER pair these with fontWeight — pick the weight via token.
export const fonts = {
  display: 'Fraunces_600SemiBold',
  displayBold: 'Fraunces_700Bold',
  body: 'Manrope_400Regular',
  bodyMedium: 'Manrope_500Medium',
  bodySemiBold: 'Manrope_600SemiBold',
  bodyBold: 'Manrope_700Bold',
  mono: 'IBMPlexMono_400Regular',
  monoSemiBold: 'IBMPlexMono_600SemiBold',
};

// Semantic backdrop gradients (docs/DESIGN.md §2) — two close same-temperature stops,
// rendered diagonally. Use only when the surface MEANS the condition.
export const gradients: Record<string, [string, string]> = {
  paper: ['#FBFAF7', '#F3F2EA'],
  meadow: ['#EAF1E3', '#FAF9F1'],
  straw: ['#F7EFD7', '#FBF8EE'],
  clay: ['#F6E2D9', '#FBF6F1'],
  eucalyptus: ['#E2EDEB', '#F6F8F5'],
  skyClear: ['#FBEFC9', '#F4F5E7'],
  skyHot: ['#F6DEBB', '#F8EFDC'],
  skyRain: ['#D9E6E7', '#EFF3F0'],
  skyCloud: ['#EBECE6', '#F5F5F0'],
  skyFrost: ['#E2ECF0', '#F2F6F5'],
  forest: ['#2C5A40', '#1F4430'],
};

export const severityColor: Record<string, string> = {
  info: colors.info,
  warning: colors.warning,
  critical: colors.danger,
};

// Severity tag tints (chips) — the matching backdrop lives in severityGradient below.
export const severityTint: Record<string, { fg: string; bg: string }> = {
  critical: { fg: '#A5432B', bg: '#F7E7E2' },
  warning: { fg: '#9A6A1E', bg: '#F6EFDD' },
  info: { fg: '#5B8F8A', bg: '#E5EEED' },
};

/** Severity → semantic backdrop recipe (critical=clay, warning=straw, info=eucalyptus). */
export function severityGradient(severity?: string | null): [string, string] {
  if (severity === 'critical') return gradients.clay;
  if (severity === 'warning') return gradients.straw;
  return gradients.eucalyptus;
}

// Parcel/alert health status: chip tint + text color pairs.
export type Status = 'healthy' | 'watch' | 'attention';
export const statusColors: Record<Status, { fg: string; bg: string }> = {
  healthy: { fg: '#3F7D45', bg: '#E9EFE9' },
  watch: { fg: '#9A6A1E', bg: '#F6EFDD' },
  attention: { fg: '#A5432B', bg: '#F7E7E2' },
};

/** Status → semantic backdrop recipe (healthy=meadow, watch=straw, attention=clay). */
export function statusGradient(status: Status): [string, string] {
  if (status === 'attention') return gradients.clay;
  if (status === 'watch') return gradients.straw;
  return gradients.meadow;
}

/** Worst open-alert severity → parcel status (no alert = healthy). */
export function statusForSeverity(severity?: string | null): Status {
  if (severity === 'critical') return 'attention';
  if (severity === 'warning') return 'watch';
  return 'healthy';
}

/** Day condition → sky backdrop (docs/DESIGN.md §2 weather mapping). */
export function weatherGradient(
  tMin: number | null | undefined,
  tMax: number | null | undefined,
  precipMm: number | null | undefined,
): [string, string] {
  if (tMin != null && tMin <= 0) return gradients.skyFrost;
  if ((precipMm ?? 0) >= 1) return gradients.skyRain;
  if (tMax != null && tMax >= 32) return gradients.skyHot;
  if (tMax != null && tMax >= 20) return gradients.skyClear;
  return gradients.skyCloud;
}

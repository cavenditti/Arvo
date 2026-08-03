// OWNER: fe-shell — Terra design language tokens (docs/DESIGN.md). Other code imports tokens,
// never hardcodes colors/fonts. Extend here first when a screen needs something new.
import { DynamicColorIOS, Platform } from 'react-native';

/**
 * One semantic token with a Terra light and dark value. iOS keeps this as a native dynamic
 * UIColor, so an already-mounted view updates with the system appearance without rebuilding its
 * StyleSheet. Web uses the equivalent CSS color function; Android keeps the light fallback until
 * the generated native project can provide paired resource colors.
 *
 * The public type stays `string` because a few shared helpers also use tokens in CSS-only values.
 * React Native accepts the native color object anywhere it accepts a ColorValue.
 */
function adaptive(light: string, dark: string): string {
  if (Platform.OS === 'ios') {
    return DynamicColorIOS({
      light,
      dark,
      highContrastLight: light,
      highContrastDark: dark,
    }) as unknown as string;
  }
  if (Platform.OS === 'web') return `light-dark(${light}, ${dark})`;
  return light;
}

export const colors = {
  primary: adaptive('#234B34', '#9BC7A5'), // forest green — actions, active states
  primaryDark: adaptive('#1F4430', '#B9DDBF'),
  primarySoft: adaptive('#E9EFE9', '#203329'), // tinted green surface (active nav, healthy chip)
  accent: adaptive('#A5432B', '#F09A80'), // clay
  bg: adaptive('#F2F1EC', '#101410'), // paper / night soil
  card: adaptive('#FBFAF7', '#181D18'),
  cardAlt: adaptive('#F6F5F2', '#202720'), // inset panels on top of card
  text: adaptive('#1B1E1A', '#F3F3EC'),
  textMuted: adaptive('#5C625C', '#B7BEB5'),
  textFaint: adaptive('#8A8F86', '#899188'),
  border: adaptive('#E4E1D7', '#343B34'),
  borderSoft: adaptive('#EDECE7', '#282F28'),
  danger: adaptive('#A5432B', '#F09A80'),
  warning: adaptive('#9A6A1E', '#E3BD70'), // straw
  info: adaptive('#5B8F8A', '#83C6C0'), // eucalyptus
  success: adaptive('#3F7D45', '#87C68C'), // leaf
  onPrimary: adaptive('#F6F5F2', '#102016'),
  focus: adaptive('#6D8F78', '#B8D5C1'), // keyboard focus ring
};

// iOS 26 Liquid Glass preserves Terra's warm field-notebook palette beneath native material.
// These tints are intentionally restrained: the system provides the refraction, highlight and
// edge treatment; the app only supplies a faint contextual color. Every glass surface has the
// existing paper/card treatment as its fallback on older iOS versions and other platforms.
export const glass = {
  tint: adaptive('#F8F8F4', '#202620'),
  actionTint: adaptive('#234B34', '#9BC7A5'),
  selectionTint: adaptive('rgba(35, 75, 52, 0.12)', 'rgba(155, 199, 165, 0.18)'),
};

/** Floating bottom-navigation geometry shared by content, overlays and transient UI. */
export const navigationMetrics = {
  barHeight: 64,
  controlGap: 8,
  contentBottomInset: 96,
} as const;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
export const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 };

// Frozen type scale (docs/UX-REVAMP.md §Frozen module contracts). `caption` (12) is the floor
// for data labels; `maxMult` caps Dynamic Type via maxFontSizeMultiplier — never disable scaling.
export const type = {
  caption: 12,
  body: 14,
  bodyLg: 16,
  title: 18,
  titleLg: 22,
  hero: 34,
  maxMult: 1.4,
} as const;

// Minimum touch targets (pt): primary actions ≥ min, chips ≥ chip (docs/DESIGN.md §Touch targets).
export const touch = { min: 44, chip: 40 } as const;

// Interaction timing shared by web controls. React Native ignores these web-only declarations;
// the actual states are applied by InteractivePressable in components/ui.tsx.
export const motion = { fast: '120ms', normal: '180ms' } as const;

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
  paper: [adaptive('#FBFAF7', '#181D18'), adaptive('#F3F2EA', '#151A15')],
  meadow: [adaptive('#EAF1E3', '#1A2B20'), adaptive('#FAF9F1', '#171F19')],
  straw: [adaptive('#F7EFD7', '#2D281A'), adaptive('#FBF8EE', '#201E17')],
  clay: [adaptive('#F6E2D9', '#2F201C'), adaptive('#FBF6F1', '#211917')],
  eucalyptus: [adaptive('#E2EDEB', '#192928'), adaptive('#F6F8F5', '#171E1D')],
  skyClear: [adaptive('#FBEFC9', '#2B291B'), adaptive('#F4F5E7', '#1C2119')],
  skyHot: [adaptive('#F6DEBB', '#302319'), adaptive('#F8EFDC', '#211C17')],
  skyRain: [adaptive('#D9E6E7', '#17272A'), adaptive('#EFF3F0', '#171E1D')],
  skyCloud: [adaptive('#EBECE6', '#242824'), adaptive('#F5F5F0', '#181C18')],
  skyFrost: [adaptive('#E2ECF0', '#1A262C'), adaptive('#F2F6F5', '#171E1F')],
  forest: [adaptive('#2C5A40', '#9BC7A5'), adaptive('#1F4430', '#78A985')],
};

/** Below this width, the web app follows the native phone/tablet navigation and stacking. */
export const WEB_COMPACT_BREAKPOINT = 960;

export const severityColor: Record<string, string> = {
  info: colors.info,
  warning: colors.warning,
  critical: colors.danger,
};

// Severity tag tints (chips) — the matching backdrop lives in severityGradient below.
export const severityTint: Record<string, { fg: string; bg: string }> = {
  critical: { fg: adaptive('#A5432B', '#F09A80'), bg: adaptive('#F7E7E2', '#38231E') },
  warning: { fg: adaptive('#9A6A1E', '#E3BD70'), bg: adaptive('#F6EFDD', '#332C1B') },
  info: { fg: adaptive('#5B8F8A', '#83C6C0'), bg: adaptive('#E5EEED', '#1C302F') },
};

/** Severity → semantic backdrop recipe (critical=clay, warning=straw, info=eucalyptus). */
export function severityGradient(severity?: string | null): [string, string] {
  if (severity === 'critical') return gradients.clay;
  if (severity === 'warning') return gradients.straw;
  return gradients.eucalyptus;
}

// Alert lifecycle state → chip tint (shared by AlertList and the web alerts screen).
export type AlertStateKey = 'open' | 'acked' | 'snoozed' | 'dismissed';
export const alertStateTint: Record<AlertStateKey, { fg: string; bg: string }> = {
  open: { fg: colors.primary, bg: colors.primarySoft },
  acked: { fg: colors.textMuted, bg: colors.borderSoft },
  snoozed: { fg: colors.info, bg: severityTint.info.bg },
  dismissed: { fg: colors.textFaint, bg: colors.borderSoft },
};

// Parcel/alert health status: chip tint + text color pairs.
export type Status = 'healthy' | 'watch' | 'attention';
export const statusColors: Record<Status, { fg: string; bg: string }> = {
  healthy: { fg: adaptive('#3F7D45', '#87C68C'), bg: adaptive('#E9EFE9', '#203329') },
  watch: { fg: adaptive('#9A6A1E', '#E3BD70'), bg: adaptive('#F6EFDD', '#332C1B') },
  attention: { fg: adaptive('#A5432B', '#F09A80'), bg: adaptive('#F7E7E2', '#38231E') },
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

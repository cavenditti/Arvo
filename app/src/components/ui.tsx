// OWNER: fe-shell — Terra UI kit (docs/DESIGN.md): presentational primitives shared across
// screens. Theme tokens only; no fontWeight next to Terra families — weights are families.
import { LinearGradient } from 'expo-linear-gradient';
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect';
import type { ReactNode } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextStyle,
  type ViewProps,
  type ViewStyle,
} from 'react-native';

import type { IndexName } from '@/api/types';
import Glyph, { type GlyphName } from '@/components/glyphs';
import { indexColor } from '@/features/insights/format';
import * as haptics from '@/lib/haptics';
import {
  colors,
  fonts,
  glass,
  motion,
  radius,
  spacing,
  statusColors,
  touch,
  type as typeScale,
  type Status,
} from '@/theme';

type InteractiveState = { hovered?: boolean; focused?: boolean; pressed: boolean };

/**
 * Liquid Glass is a runtime capability: importing the component is safe, but rendering it on
 * early iOS 26 betas without the underlying API is not. Keep the check in one place and fall
 * back to Terra paper everywhere else.
 */
const nativeLiquidGlass = (() => {
  if (Platform.OS !== 'ios') return false;
  try {
    return isGlassEffectAPIAvailable() && isLiquidGlassAvailable();
  } catch {
    return false;
  }
})();

export function hasNativeLiquidGlass(): boolean {
  return nativeLiquidGlass;
}

type GlassSurfaceProps = Omit<ViewProps, 'children' | 'style'> & {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Existing opaque treatment used on non-Liquid-Glass platforms. */
  fallbackStyle?: StyleProp<ViewStyle>;
  tintColor?: string;
  isInteractive?: boolean;
};

/**
 * A platform-adaptive visual surface. On supported iOS devices it is a real UIKit liquid-glass
 * material; elsewhere it is the supplied paper treatment. Do not animate this component or one
 * of its ancestors with `opacity` — use transforms or the native glass style animation instead.
 */
export function GlassSurface({
  children,
  style,
  fallbackStyle,
  tintColor = glass.tint,
  isInteractive = false,
  ...props
}: GlassSurfaceProps) {
  if (!nativeLiquidGlass) {
    return (
      <View {...props} style={[fallbackStyle, style]}>
        {children}
      </View>
    );
  }

  return (
    <GlassView
      {...props}
      style={[style, styles.liquidSurface]}
      tintColor={tintColor}
      isInteractive={isInteractive}
      glassEffectStyle="regular"
    >
      {children}
    </GlassView>
  );
}

type InteractivePressableProps = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle> | ((state: InteractiveState) => StyleProp<ViewStyle>);
  hoverStyle?: StyleProp<ViewStyle>;
  focusStyle?: StyleProp<ViewStyle>;
  pressedStyle?: StyleProp<ViewStyle>;
  /** Fire a selection haptic tick on press-in (native only — silent no-op on web). */
  haptic?: boolean;
};

/**
 * One interaction contract for every button, row and text link. Web gets a pointer cursor,
 * a short transition and keyboard focus ring; touch targets get the same pressed feedback.
 */
export function InteractivePressable({
  style,
  hoverStyle,
  focusStyle,
  pressedStyle,
  disabled,
  haptic,
  onPressIn,
  accessibilityRole = 'button',
  ...props
}: InteractivePressableProps) {
  return (
    <Pressable
      {...props}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      onPressIn={(e) => {
        if (haptic && !disabled && Platform.OS !== 'web') haptics.selection();
        onPressIn?.(e);
      }}
      style={(rawState) => {
        const state = rawState as InteractiveState;
        const base = typeof style === 'function' ? style(state) : style;
        return [
          base,
          Platform.OS === 'web' && styles.interactiveWeb,
          state.hovered && !disabled && (hoverStyle ?? styles.interactiveHover),
          state.focused && !disabled && (focusStyle ?? styles.interactiveFocus),
          state.pressed && !disabled && (pressedStyle ?? styles.interactivePressed),
          disabled && styles.interactiveDisabled,
        ];
      }}
    />
  );
}

/** A circular, native-material control for toolbar actions. */
export function GlassIconButton({
  children,
  style,
  ...props
}: Omit<InteractivePressableProps, 'style' | 'pressedStyle'> & {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <InteractivePressable
      {...props}
      style={[styles.glassIconButtonTouch, style]}
      // Opacity on a GlassView ancestor disables the material, so press feedback is transform-only.
      pressedStyle={styles.glassIconButtonPressed}
    >
      <GlassSurface
        pointerEvents="none"
        style={styles.glassIconButtonSurface}
        fallbackStyle={styles.glassIconButtonFallback}
        isInteractive
      >
        {children}
      </GlassSurface>
    </InteractivePressable>
  );
}

/** Avatar initials: first + last word ("Maria Rossi Bianchi" → "MB"). One implementation so
 * the same person never renders different letters on different screens. */
export function initials(name?: string | null): string {
  if (!name) return '—';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  const a = parts[0][0] ?? '';
  const b = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (a + b).toUpperCase() || '—';
}

/** Uppercase monospace micro-label ("5 PARCELS · 14 JUL PASS", table headers, meta rows).
 * Default size = type.caption (12) — the readable floor for data labels in the field. */
export function MonoLabel({
  children,
  color = colors.textFaint,
  size = typeScale.caption,
  style,
}: {
  children: ReactNode;
  color?: string;
  size?: number;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text
      style={[styles.mono, { color, fontSize: size }, style]}
      numberOfLines={1}
      maxFontSizeMultiplier={typeScale.maxMult}
    >
      {children}
    </Text>
  );
}

/** Monospace value text (NDVI numbers, stats) — not uppercased, no letter spacing. */
export function MonoValue({
  children,
  color = colors.text,
  size = 16,
  weight = '700',
  style,
}: {
  children: ReactNode;
  color?: string;
  size?: number;
  /** '400'/'500' → regular mono; '600'+ → semibold mono (kept for caller compat) */
  weight?: TextStyle['fontWeight'];
  style?: StyleProp<TextStyle>;
}) {
  const family = Number(weight) >= 600 ? fonts.monoSemiBold : fonts.mono;
  return (
    <Text
      style={[{ fontFamily: family, color, fontSize: size }, style]}
      maxFontSizeMultiplier={typeScale.maxMult}
    >
      {children}
    </Text>
  );
}

/** Healthy / Watch / Attention pill with tinted background. */
export function StatusChip({ status, label }: { status: Status; label: string }) {
  const c = statusColors[status];
  return (
    <View style={[styles.chip, { backgroundColor: c.bg }]}>
      <Text style={[styles.chipText, { color: c.fg }]} maxFontSizeMultiplier={typeScale.maxMult}>
        {label}
      </Text>
    </View>
  );
}

/** Generic tinted pill (alert states, severity tags). */
export function Pill({ label, fg, bg }: { label: string; fg: string; bg: string }) {
  return (
    <View style={[styles.chip, { backgroundColor: bg }]}>
      <Text style={[styles.chipText, { color: fg }]} maxFontSizeMultiplier={typeScale.maxMult}>
        {label}
      </Text>
    </View>
  );
}

/** Signed index delta: "▲ +0.03" (green) / "▼ −0.11" (clay) / "—". */
export function Delta({ value, size = 12 }: { value: number | null | undefined; size?: number }) {
  if (value == null || Number.isNaN(value)) {
    return <MonoValue color={colors.textFaint} size={size} weight="600">—</MonoValue>;
  }
  const up = value >= 0;
  const color = up ? colors.success : colors.accent;
  const text = `${up ? '▲' : '▼'} ${up ? '+' : '−'}${Math.abs(value).toFixed(2)}`;
  return (
    <MonoValue color={color} size={size} weight="600">
      {text}
    </MonoValue>
  );
}

/** Rounded square tinted by the index value, value printed inside (parcel list, map cards). */
export function NdviSwatch({
  value,
  index = 'ndvi',
  size = 44,
}: {
  value: number | null | undefined;
  index?: IndexName;
  size?: number;
}) {
  return (
    <View
      style={[
        styles.swatch,
        { width: size, height: size, borderRadius: Math.round(size * 0.27) },
        { backgroundColor: value == null ? colors.borderSoft : indexColor(index, value) },
      ]}
    >
      <Text
        style={[
          styles.swatchText,
          { fontSize: Math.round(size * 0.3) },
          value == null && { color: colors.textFaint },
        ]}
        maxFontSizeMultiplier={typeScale.maxMult}
      >
        {value == null ? '—' : value.toFixed(2)}
      </Text>
    </View>
  );
}

/** Content-layer paper card. Liquid Glass is reserved for floating navigation and controls. */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

/**
 * Semantic gradient card (docs/DESIGN.md §2): pass a `gradients.*` recipe (preferred) or a
 * single `tint` that fades into the card color. Never left-border accents.
 */
export function TintCard({
  tint,
  gradient,
  children,
  style,
}: {
  tint?: string;
  gradient?: [string, string];
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const stops = gradient ?? [tint ?? colors.card, colors.card];
  return (
    <LinearGradient
      colors={stops}
      start={{ x: 0, y: 0 }}
      end={{ x: 0.9, y: 1 }}
      style={[styles.tintCard, style]}
    >
      {children}
    </LinearGradient>
  );
}

/**
 * TintCard carrying one oversized glyph bleeding off the bottom-right corner, toned into the
 * backdrop (docs/DESIGN.md §5). Content renders above the glyph.
 */
export function GlyphCard({
  gradient,
  glyph,
  glyphColor,
  glyphOpacity = 0.16,
  glyphSize,
  children,
  style,
}: {
  gradient: [string, string];
  glyph: GlyphName;
  /** deeper tone of the backdrop hue */
  glyphColor: string;
  glyphOpacity?: number;
  /** defaults to 1.25 × card height via percentage sizing fallback (120) */
  glyphSize?: number;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const size = glyphSize ?? 120;
  return (
    <LinearGradient
      colors={gradient}
      start={{ x: 0, y: 0 }}
      end={{ x: 0.9, y: 1 }}
      style={[styles.tintCard, styles.glyphCard, style]}
    >
      <View
        pointerEvents="none"
        style={[
          styles.glyphBleed,
          // subtle bleed (~10–12% off each edge): the glyph stays ~three-quarters visible
          { opacity: glyphOpacity, right: -size * 0.1, bottom: -size * 0.12 },
        ]}
      >
        <Glyph name={glyph} size={size} color={glyphColor} />
      </View>
      <View style={styles.glyphContent}>{children}</View>
    </LinearGradient>
  );
}

/** Small tinted rounded-square with a glyph — the Terra replacement for state dots. */
export function GlyphBadge({
  glyph,
  fg,
  bg,
  size = 26,
}: {
  glyph: GlyphName;
  fg: string;
  bg: string;
  size?: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Glyph name={glyph} size={Math.round(size * 0.62)} color={fg} />
    </View>
  );
}

// NB: there is deliberately no `Dot` here — Terra bans bare state dots (docs/DESIGN.md §5).
// Use StatusChip, Pill, or GlyphBadge instead.

const styles = StyleSheet.create({
  interactiveWeb: {
    cursor: 'pointer',
    transitionProperty: 'background-color, border-color, color, opacity, transform, box-shadow',
    transitionDuration: motion.fast,
    transitionTimingFunction: 'ease-out',
  } as ViewStyle,
  interactiveHover: { opacity: 0.86, transform: [{ translateY: -1 }] },
  interactiveFocus: {
    outlineColor: colors.focus,
    outlineOffset: 2,
    outlineStyle: 'solid',
    outlineWidth: 2,
  } as ViewStyle,
  interactivePressed: { opacity: 0.76, transform: [{ scale: 0.985 }] },
  interactiveDisabled: { opacity: 0.48, cursor: 'not-allowed' } as unknown as ViewStyle,
  // Applied after the caller's styles so paper fills and manual hairlines never paint over
  // the system material or its native edge treatment.
  liquidSurface: { backgroundColor: 'transparent', borderWidth: 0 },
  glassIconButtonTouch: {
    width: touch.min,
    height: touch.min,
    borderRadius: touch.min / 2,
  },
  glassIconButtonSurface: {
    flex: 1,
    borderRadius: touch.min / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glassIconButtonFallback: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  glassIconButtonPressed: { transform: [{ scale: 0.94 }] },
  mono: {
    fontFamily: fonts.monoSemiBold,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
    minHeight: 28,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  chipText: { fontSize: typeScale.caption, fontFamily: fonts.bodyBold },
  swatch: { alignItems: 'center', justifyContent: 'center' },
  swatchText: { fontFamily: fonts.monoSemiBold, color: '#FFFFFF' },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  tintCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    padding: spacing.sm,
    overflow: 'hidden',
  },
  glyphCard: { position: 'relative' },
  glyphBleed: { position: 'absolute' },
  glyphContent: { position: 'relative' },
});

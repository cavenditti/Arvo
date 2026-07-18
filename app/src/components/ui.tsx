// OWNER: fe-shell — Terra UI kit (docs/DESIGN.md): presentational primitives shared across
// screens. Theme tokens only; no fontWeight next to Terra families — weights are families.
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import type { IndexName } from '@/api/types';
import Glyph, { type GlyphName } from '@/components/glyphs';
import { indexColor } from '@/features/insights/format';
import { colors, fonts, radius, spacing, statusColors, type Status } from '@/theme';

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

/** Uppercase monospace micro-label ("5 PARCELS · 14 JUL PASS", table headers, meta rows). */
export function MonoLabel({
  children,
  color = colors.textFaint,
  size = 10,
  style,
}: {
  children: ReactNode;
  color?: string;
  size?: number;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text style={[styles.mono, { color, fontSize: size }, style]} numberOfLines={1}>
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
    <Text style={[{ fontFamily: family, color, fontSize: size }, style]}>{children}</Text>
  );
}

/** Healthy / Watch / Attention pill with tinted background. */
export function StatusChip({ status, label }: { status: Status; label: string }) {
  const c = statusColors[status];
  return (
    <View style={[styles.chip, { backgroundColor: c.bg }]}>
      <Text style={[styles.chipText, { color: c.fg }]}>{label}</Text>
    </View>
  );
}

/** Generic tinted pill (alert states, severity tags). */
export function Pill({ label, fg, bg }: { label: string; fg: string; bg: string }) {
  return (
    <View style={[styles.chip, { backgroundColor: bg }]}>
      <Text style={[styles.chipText, { color: fg }]}>{label}</Text>
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
      >
        {value == null ? '—' : value.toFixed(2)}
      </Text>
    </View>
  );
}

/** Paper card: soft border, large radius. */
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
  mono: {
    fontFamily: fonts.monoSemiBold,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  chipText: { fontSize: 11, fontFamily: fonts.bodyBold },
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

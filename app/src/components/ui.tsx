// OWNER: fe-shell — Campo UI kit: small presentational primitives shared across screens
// (status chips, mono micro-labels, deltas, NDVI swatches, cards). Theme tokens only.
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import type { IndexName } from '@/api/types';
import { indexColor } from '@/features/insights/format';
import { colors, fonts, radius, spacing, statusColors, type Status } from '@/theme';

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
  weight?: TextStyle['fontWeight'];
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text style={[{ fontFamily: fonts.mono, color, fontSize: size, fontWeight: weight }, style]}>
      {children}
    </Text>
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

/** Signed index delta: "▲ +0.03" (green) / "▼ −0.11" (terracotta) / "—". */
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
 * Severity-tinted card: subtle diagonal fade from `tint` into the card color (mock style).
 * Use INSTEAD of colored left-border accents — never those.
 */
export function TintCard({
  tint,
  children,
  style,
}: {
  tint: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <LinearGradient
      colors={[tint, colors.card]}
      start={{ x: 0, y: 0 }}
      end={{ x: 0.9, y: 1 }}
      locations={[0, 0.65]}
      style={[styles.tintCard, style]}
    >
      {children}
    </LinearGradient>
  );
}

/** Colored severity/status dot. */
export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

const styles = StyleSheet.create({
  mono: {
    fontFamily: fonts.mono,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontWeight: '600',
  },
  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  chipText: { fontSize: 11, fontWeight: '700' },
  swatch: { alignItems: 'center', justifyContent: 'center' },
  swatchText: { fontFamily: fonts.mono, fontWeight: '700', color: '#FFFFFF' },
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
});

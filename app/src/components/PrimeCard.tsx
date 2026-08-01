// OWNER: foundation-ui — permission priming card (docs/UX-REVAMP.md frozen contract,
// docs/DESIGN.md §Permission priming). Shown BEFORE any system permission dialog: explains in
// plain words why Arvo asks, with an honest way to say "not now". Callers pass i18n keys.
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Card, InteractivePressable } from '@/components/ui';
import { colors, fonts, gradients, radius, spacing, touch, type as typeScale } from '@/theme';

export interface PrimeCardProps {
  icon: keyof typeof Ionicons.glyphMap;
  titleKey: string;
  bodyKey: string;
  ctaKey: string;
  laterKey?: string;
  onAccept(): void;
  onLater?(): void;
}

export default function PrimeCard({
  icon,
  titleKey,
  bodyKey,
  ctaKey,
  laterKey,
  onAccept,
  onLater,
}: PrimeCardProps) {
  const { t } = useTranslation();

  return (
    <Card style={styles.card}>
      <View style={styles.iconCircle}>
        <Ionicons name={icon} size={28} color={colors.primary} />
      </View>
      <Text style={styles.title} maxFontSizeMultiplier={typeScale.maxMult}>
        {t(titleKey)}
      </Text>
      <Text style={styles.body} maxFontSizeMultiplier={typeScale.maxMult}>
        {t(bodyKey)}
      </Text>
      <InteractivePressable haptic style={styles.cta} onPress={onAccept}>
        <LinearGradient
          colors={gradients.forest}
          start={{ x: 0, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={styles.ctaInner}
        >
          <Text style={styles.ctaText} maxFontSizeMultiplier={typeScale.maxMult}>
            {t(ctaKey)}
          </Text>
        </LinearGradient>
      </InteractivePressable>
      {laterKey != null && onLater != null && (
        <InteractivePressable style={styles.later} onPress={onLater}>
          <Text style={styles.laterText} maxFontSizeMultiplier={typeScale.maxMult}>
            {t(laterKey)}
          </Text>
        </InteractivePressable>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { alignItems: 'center', padding: spacing.lg, gap: spacing.sm },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: typeScale.titleLg,
    color: colors.text,
    textAlign: 'center',
  },
  body: {
    fontFamily: fonts.body,
    fontSize: typeScale.bodyLg,
    lineHeight: 22,
    color: colors.textMuted,
    textAlign: 'center',
  },
  cta: { alignSelf: 'stretch', marginTop: spacing.sm, borderRadius: radius.lg },
  ctaInner: {
    minHeight: touch.min,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  ctaText: { fontFamily: fonts.bodyBold, fontSize: typeScale.bodyLg, color: colors.onPrimary },
  later: {
    minHeight: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  laterText: { fontFamily: fonts.bodySemiBold, fontSize: typeScale.body, color: colors.textMuted },
});

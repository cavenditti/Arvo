import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { cropLabelKey } from '@/features/parcels/crops';
import type { SatelliteAnalysis } from '@/features/parcels/hooks';
import { colors, fonts, radius, spacing, type as typeScale } from '@/theme';

interface Props {
  analysis: SatelliteAnalysis | undefined;
  loading?: boolean;
}

/** One compact satellite summary. Source and resolution belong in advanced detail, not in every
 * field's primary reading order. */
export default function SatelliteAnalysisCard({ analysis, loading = false }: Props) {
  const { t } = useTranslation();
  const pending = loading || !analysis || analysis.status === 'pending';
  const crop = analysis?.crop ? t(cropLabelKey(analysis.crop)) : null;
  const confidence = analysis?.confidence == null ? null : Math.round(analysis.confidence * 100);
  const cover =
    analysis?.vegetation?.cover_pct == null
      ? null
      : Math.round(analysis.vegetation.cover_pct);

  return (
    <View style={styles.card}>
      <View style={styles.heading}>
        <View style={styles.icon}>
          <Ionicons name="scan-outline" size={20} color={colors.primary} />
        </View>
        <Text style={[styles.title, styles.grow]} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('satellite_detection.title')}
        </Text>
        {pending ? <ActivityIndicator size="small" color={colors.primary} /> : null}
      </View>

      {!pending ? (
        <Text style={styles.body} numberOfLines={2} maxFontSizeMultiplier={typeScale.maxMult}>
          {[
            crop && confidence != null
              ? t('satellite_detection.crop_result', { crop, confidence })
              : t('satellite_detection.crop_uncertain'),
            cover != null
              ? t(
                  analysis?.vegetation?.detected
                    ? 'satellite_detection.vegetation_result'
                    : 'satellite_detection.vegetation_low',
                  { cover },
                )
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderColor: colors.borderSoft,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  heading: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  icon: {
    alignItems: 'center',
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  grow: { flex: 1 },
  title: { color: colors.text, fontFamily: fonts.bodyBold, fontSize: 16 },
  body: { color: colors.text, flex: 1, fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
});

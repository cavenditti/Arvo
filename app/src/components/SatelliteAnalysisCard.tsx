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

/** Human-readable Sentinel-2 crop/vegetation result. The resolution note is part of the feature:
 * parcel vegetation is observable at 10 m, individual vines/trees are not. */
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
        <View style={styles.grow}>
          <Text style={styles.title} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('satellite_detection.title')}
          </Text>
          <Text style={styles.eyebrow} maxFontSizeMultiplier={typeScale.maxMult}>
            SENTINEL-2 · 10 M
          </Text>
        </View>
        {pending ? <ActivityIndicator size="small" color={colors.primary} /> : null}
      </View>

      {pending ? (
        <Text style={styles.body} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('satellite_detection.pending')}
        </Text>
      ) : (
        <View style={styles.results}>
          <View style={styles.resultRow}>
            <Ionicons name="leaf-outline" size={18} color={colors.primary} />
            <Text style={styles.body} maxFontSizeMultiplier={typeScale.maxMult}>
              {crop && confidence != null
                ? t('satellite_detection.crop_result', { crop, confidence })
                : t('satellite_detection.crop_uncertain')}
            </Text>
          </View>
          <View style={styles.resultRow}>
            <Ionicons name="grid-outline" size={18} color={colors.primary} />
            <Text style={styles.body} maxFontSizeMultiplier={typeScale.maxMult}>
              {cover != null
                ? t(
                    analysis?.vegetation?.detected
                      ? 'satellite_detection.vegetation_result'
                      : 'satellite_detection.vegetation_low',
                    { cover },
                  )
                : t('satellite_detection.vegetation_pending')}
            </Text>
          </View>
          {analysis?.applied_to_parcel ? (
            <Text style={styles.applied} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('satellite_detection.applied')}
            </Text>
          ) : null}
        </View>
      )}

      <Text style={styles.note} maxFontSizeMultiplier={typeScale.maxMult}>
        {t('satellite_detection.resolution_note')}
      </Text>
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
  eyebrow: {
    color: colors.textFaint,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.7,
    marginTop: 2,
  },
  results: { gap: spacing.xs },
  resultRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  body: { color: colors.text, flex: 1, fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
  applied: { color: colors.primary, fontFamily: fonts.bodyBold, fontSize: 12 },
  note: { color: colors.textMuted, fontFamily: fonts.body, fontSize: 12, lineHeight: 17 },
});

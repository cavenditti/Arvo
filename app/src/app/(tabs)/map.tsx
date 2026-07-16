// OWNER: fe-map — Map tab: every parcel on Leaflet, filled by latest-NDVI choropleth, tap → detail,
// floating + → new parcel.
import { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import MapView from '@/components/MapView';
import type { ParcelFeature } from '@/components/types';
import { NEUTRAL_FILL, ndviColor } from '@/features/parcels/crops';
import { useLatestIndices, useParcels } from '@/features/parcels/hooks';
import { colors, radius, spacing } from '@/theme';

const LEGEND: { color: string; label: string }[] = [
  { color: '#d9534f', label: '< 0.3' },
  { color: '#f0ad4e', label: '0.3–0.5' },
  { color: '#9acd32', label: '0.5–0.65' },
  { color: '#2E7D32', label: '≥ 0.65' },
  { color: NEUTRAL_FILL, label: 'n/d' },
];

export default function MapScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const parcelsQ = useParcels();

  const parcels = useMemo(
    () => (parcelsQ.data ?? []).filter((p) => !p.archived),
    [parcelsQ.data],
  );
  const ids = useMemo(() => parcels.map((p) => p.id), [parcels]);
  const latestQ = useLatestIndices(ids);

  const features: ParcelFeature[] = useMemo(() => {
    const latest = latestQ.data ?? {};
    return parcels.map((parcel) => ({
      parcel,
      color: ndviColor(latest[parcel.id]?.ndvi?.mean ?? null),
    }));
  }, [parcels, latestQ.data]);

  return (
    <View style={styles.root}>
      {parcelsQ.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : parcelsQ.isError ? (
        <View style={styles.center}>
          <Text style={styles.msg}>{t('map.load_error')}</Text>
          <Pressable style={styles.retry} onPress={() => parcelsQ.refetch()}>
            <Text style={styles.retryTxt}>{t('common.retry')}</Text>
          </Pressable>
        </View>
      ) : (
        <MapView
          parcels={features}
          mode="view"
          onSelectParcel={(id) => router.push(`/parcel/${id}`)}
        />
      )}

      {!parcelsQ.isLoading && !parcelsQ.isError && parcels.length === 0 ? (
        <View style={styles.emptyWrap} pointerEvents="none">
          <View style={styles.emptyCard}>
            <Ionicons name="map-outline" size={28} color={colors.textMuted} />
            <Text style={styles.emptyTxt}>{t('map.empty')}</Text>
          </View>
        </View>
      ) : null}

      {parcels.length > 0 ? (
        <View style={styles.legend} pointerEvents="none">
          <Text style={styles.legendTitle}>{t('map.ndvi_legend')}</Text>
          <View style={styles.legendRow}>
            {LEGEND.map((l) => (
              <View key={l.label} style={styles.legendItem}>
                <View style={[styles.swatch, { backgroundColor: l.color }]} />
                <Text style={styles.legendLabel}>{l.label}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      <Pressable
        style={styles.fab}
        onPress={() => router.push('/parcel/new')}
        accessibilityLabel={t('map.add_parcel')}
      >
        <Ionicons name="add" size={30} color="#fff" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  msg: { color: colors.textMuted, fontSize: 15 },
  retry: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
  },
  retryTxt: { color: '#fff', fontWeight: '600' },
  emptyWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyCard: {
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyTxt: { color: colors.textMuted, fontSize: 15, textAlign: 'center' },
  legend: {
    position: 'absolute',
    left: spacing.md,
    bottom: spacing.md,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
  },
  legendTitle: { fontSize: 11, fontWeight: '700', color: colors.text, marginBottom: 2 },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, maxWidth: 230 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  legendLabel: { fontSize: 10, color: colors.textMuted },
  fab: {
    position: 'absolute',
    right: spacing.md,
    bottom: spacing.md,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
});

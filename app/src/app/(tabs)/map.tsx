// OWNER: fe-map — Map tab: every parcel on Leaflet, filled by latest selected-index choropleth,
// floating search (filter + focus) and index-cycle chip, tap → bottom selection card, floating +
// → new parcel.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api } from '@/api/client';
import { INDEX_NAMES, type Alert, type IndexName } from '@/api/types';
import MapView from '@/components/MapView';
import type { ParcelFeature } from '@/components/types';
import { MonoLabel, MonoValue, NdviSwatch, StatusChip } from '@/components/ui';
import { INDEX_DOMAIN, cropLabel, indexColor } from '@/features/insights/format';
import { NEUTRAL_FILL, formatArea, ndviColor } from '@/features/parcels/crops';
import { useLatestIndices, useParcels } from '@/features/parcels/hooks';
import { colors, radius, spacing, statusForSeverity } from '@/theme';

const LEGEND: { color: string; label: string }[] = [
  { color: ndviColor(0.2), label: '< 0.3' },
  { color: ndviColor(0.4), label: '0.3–0.5' },
  { color: ndviColor(0.6), label: '0.5–0.65' },
  { color: ndviColor(0.8), label: '≥ 0.65' },
  { color: NEUTRAL_FILL, label: 'n/d' },
];

// Selection-card height guess used for the FAB offset until onLayout reports the real value.
const CARD_HEIGHT_ESTIMATE = 148;

const SEVERITY_RANK: Record<string, number> = { info: 1, warning: 2, critical: 3 };

/** Worst open-alert severity for a parcel (alerts already filtered to state=open). */
function worstOpenSeverity(alerts: Alert[], parcelId: string): string | null {
  let worst: string | null = null;
  for (const a of alerts) {
    if (a.parcel_id !== parcelId) continue;
    if ((SEVERITY_RANK[a.severity] ?? 0) > (worst ? (SEVERITY_RANK[worst] ?? 0) : 0)) {
      worst = a.severity;
    }
  }
  return worst;
}

export default function MapScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const parcelsQ = useParcels();

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState<IndexName>('ndvi');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<[number, number, number?] | undefined>(undefined);
  const [cardHeight, setCardHeight] = useState(0);
  // last parcel focused from the search box — avoids re-setting focus on every keystroke
  const focusedIdRef = useRef<string | null>(null);

  const parcels = useMemo(
    () => (parcelsQ.data ?? []).filter((p) => !p.archived),
    [parcelsQ.data],
  );
  // latest-indices query key stays stable while typing: always fetch for all parcels
  const ids = useMemo(() => parcels.map((p) => p.id), [parcels]);
  const latestQ = useLatestIndices(ids);

  const openAlertsQ = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: () => api.get<Alert[]>('/alerts?state=open'),
  });

  const features: ParcelFeature[] = useMemo(() => {
    const latest = latestQ.data ?? {};
    const q = query.trim().toLowerCase();
    const visible = q ? parcels.filter((p) => p.name.toLowerCase().includes(q)) : parcels;
    return visible.map((parcel) => {
      const mean = latest[parcel.id]?.[selectedIndex]?.mean ?? null;
      return { parcel, color: mean == null ? NEUTRAL_FILL : indexColor(selectedIndex, mean) };
    });
  }, [parcels, latestQ.data, selectedIndex, query]);

  // Search → focus the first name match; clear focus (map refits bounds) when text is cleared.
  useEffect(() => {
    const q = query.trim().toLowerCase();
    const match = q ? parcels.find((p) => p.name.toLowerCase().includes(q)) : undefined;
    if (!match) {
      focusedIdRef.current = null;
      setFocus(undefined);
      return;
    }
    if (focusedIdRef.current !== match.id) {
      focusedIdRef.current = match.id;
      setFocus([match.centroid.lon, match.centroid.lat, 15]);
    }
  }, [query, parcels]);

  const selected = selectedId ? (parcels.find((p) => p.id === selectedId) ?? null) : null;
  const selectedStatus = statusForSeverity(
    selected ? worstOpenSeverity(openAlertsQ.data ?? [], selected.id) : null,
  );
  const selectedMean = selected
    ? (latestQ.data?.[selected.id]?.[selectedIndex]?.mean ?? null)
    : null;

  const cycleIndex = () =>
    setSelectedIndex(INDEX_NAMES[(INDEX_NAMES.indexOf(selectedIndex) + 1) % INDEX_NAMES.length]);

  const [domainMin, domainMax] = INDEX_DOMAIN[selectedIndex];
  const gradientStops = useMemo(
    () =>
      Array.from({ length: 5 }, (_, i) =>
        indexColor(selectedIndex, domainMin + ((domainMax - domainMin) * i) / 4),
      ),
    [selectedIndex, domainMin, domainMax],
  );

  const mapReady = !parcelsQ.isLoading && !parcelsQ.isError;

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
          focus={focus}
          onSelectParcel={(id) => setSelectedId(id)}
        />
      )}

      {mapReady && parcels.length === 0 ? (
        <View style={styles.emptyWrap} pointerEvents="none">
          <View style={styles.emptyCard}>
            <Ionicons name="map-outline" size={28} color={colors.textMuted} />
            <Text style={styles.emptyTxt}>{t('map.empty')}</Text>
          </View>
        </View>
      ) : null}

      {parcels.length > 0 ? (
        <View style={styles.legend} pointerEvents="none">
          <Text style={styles.legendTitle}>
            {selectedIndex === 'ndvi'
              ? t('map.ndvi_legend')
              : t('map.index_legend', {
                  defaultValue: '{{index}} (latest)',
                  index: selectedIndex.toUpperCase(),
                })}
          </Text>
          {selectedIndex === 'ndvi' ? (
            <View style={styles.legendRow}>
              {LEGEND.map((l) => (
                <View key={l.label} style={styles.legendItem}>
                  <View style={[styles.swatch, { backgroundColor: l.color }]} />
                  <Text style={styles.legendLabel}>{l.label}</Text>
                </View>
              ))}
            </View>
          ) : (
            <View style={styles.legendGradientRow}>
              <MonoValue size={10} weight="600" color={colors.textMuted}>
                {domainMin.toFixed(1)}
              </MonoValue>
              <View style={styles.gradientBar}>
                {gradientStops.map((c, i) => (
                  <View key={i} style={[styles.gradientCell, { backgroundColor: c }]} />
                ))}
              </View>
              <MonoValue size={10} weight="600" color={colors.textMuted}>
                {domainMax.toFixed(1)}
              </MonoValue>
              <View style={styles.legendItem}>
                <View style={[styles.swatch, { backgroundColor: NEUTRAL_FILL }]} />
                <Text style={styles.legendLabel}>n/d</Text>
              </View>
            </View>
          )}
        </View>
      ) : null}

      {selected ? (
        <View
          style={styles.selCard}
          onLayout={(e) => setCardHeight(e.nativeEvent.layout.height)}
        >
          <View style={styles.selRow}>
            <NdviSwatch value={selectedMean} index={selectedIndex} size={44} />
            <View style={styles.selInfo}>
              <Text style={styles.selName} numberOfLines={1}>
                {selected.name}
              </Text>
              <Text style={styles.selMeta} numberOfLines={1}>
                {[cropLabel(selected.crop), formatArea(selected.area_ha)]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
            <StatusChip status={selectedStatus} label={t(`status.${selectedStatus}`)} />
            <Pressable
              onPress={() => setSelectedId(null)}
              hitSlop={8}
              accessibilityLabel={t('map.close_selection', { defaultValue: 'Close' })}
            >
              <Ionicons name="close" size={18} color={colors.textMuted} />
            </Pressable>
          </View>
          <View style={styles.selButtons}>
            <Pressable
              style={({ pressed }) => [styles.detailBtn, pressed && styles.pressed]}
              onPress={() => router.push(`/parcel/${selected.id}`)}
            >
              <Text style={styles.detailBtnTxt}>
                {t('map.open_detail', { defaultValue: 'Open detail' })}
              </Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.scoutBtn, pressed && styles.pressed]}
              onPress={() => router.push('/observation/new')}
            >
              <Text style={styles.scoutBtnTxt}>
                {t('map.scout_here', { defaultValue: 'Scout here' })}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {mapReady ? (
        <View style={[styles.topRow, { top: insets.top + spacing.sm }]}>
          <View style={styles.search}>
            <Ionicons name="search" size={16} color={colors.textFaint} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder={t('map.search_placeholder', { defaultValue: 'Search parcels' })}
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
          </View>
          <Pressable
            style={({ pressed }) => [styles.indexChip, pressed && styles.pressed]}
            onPress={cycleIndex}
            accessibilityLabel={t('map.change_index', { defaultValue: 'Change index' })}
          >
            <MonoLabel color={colors.text} size={11}>{`${selectedIndex} ▾`}</MonoLabel>
          </Pressable>
        </View>
      ) : null}

      <Pressable
        style={[
          styles.fab,
          selected
            ? { bottom: spacing.md + (cardHeight || CARD_HEIGHT_ESTIMATE) + spacing.sm }
            : null,
        ]}
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
  topRow: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  search: {
    // web portal content can be much wider than a phone: cap the bar per the mock
    flex: 1,
    maxWidth: 420,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 40,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  searchInput: { flex: 1, fontSize: 14, color: colors.text, paddingVertical: 0 },
  indexChip: {
    height: 40,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  pressed: { opacity: 0.7 },
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
  legendGradientRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  gradientBar: { flexDirection: 'row', borderRadius: 2, overflow: 'hidden' },
  gradientCell: { width: 13, height: 10 },
  selCard: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.md,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  selRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  selInfo: { flex: 1 },
  selName: { fontSize: 16, fontWeight: '700', color: colors.text },
  selMeta: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  selButtons: { flexDirection: 'row', gap: spacing.sm },
  detailBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm + spacing.xs,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
  },
  detailBtnTxt: { color: colors.onPrimary, fontSize: 14, fontWeight: '700' },
  scoutBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm + spacing.xs,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  scoutBtnTxt: { color: colors.text, fontSize: 14, fontWeight: '600' },
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

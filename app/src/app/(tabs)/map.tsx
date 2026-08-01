// OWNER: map-native — Mappa tab: every field on Leaflet (OSM or satellite base), colored by the
// Arvo score or one chosen index, floating search with an explicit results list, bottom selection
// card driven by the shared status pipeline, labeled "Nuovo campo" pill.
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api } from '@/api/client';
import { INDEX_NAMES, type Alert, type IndexName } from '@/api/types';
import MapView from '@/components/MapView';
import { StaleBanner, useOnlineStatus } from '@/components/StaleBanner';
import type { ParcelFeature } from '@/components/types';
import { GlassSurface, InteractivePressable, MonoLabel, MonoValue, StatusChip, TintCard } from '@/components/ui';
import {
  INDEX_DOMAIN,
  arvoScoreDetail,
  cropLabel,
  indexColor,
  scoreColor,
} from '@/features/insights/format';
import { countAlertEvents } from '@/features/insights/grouping';
import { deriveFieldStatus, trendFromSeries } from '@/features/insights/status';
import { NEUTRAL_FILL, ndviColor } from '@/features/parcels/crops';
import { useIndexSeries, useLatestIndices, useParcels } from '@/features/parcels/hooks';
import { formatHectares } from '@/lib/format';
import {
  colors,
  fonts,
  gradients,
  radius,
  spacing,
  touch,
  type as typeScale,
  type Status,
} from '@/theme';

// Legend value labels are numeric ranges except the no-data slot, translated at render.
const LEGEND: { color: string; label: string | null }[] = [
  { color: ndviColor(0.2), label: '< 0.3' },
  { color: ndviColor(0.4), label: '0.3–0.5' },
  { color: ndviColor(0.6), label: '0.5–0.65' },
  { color: ndviColor(0.8), label: '≥ 0.65' },
  { color: NEUTRAL_FILL, label: null },
];

// What paints the fields: the Arvo score (default), nothing (boundaries only — the natural
// companion of the satellite basemap), or one of the five indices.
type MapChoropleth = 'score' | 'none' | IndexName;

const BASEMAP_KEY = 'arvo.map.basemap';
const MAX_SEARCH_RESULTS = 6;

export default function MapScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const online = useOnlineStatus();
  const parcelsQ = useParcels();

  const [query, setQuery] = useState('');
  const [choropleth, setChoropleth] = useState<MapChoropleth>('score');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [basemap, setBasemap] = useState<'map' | 'sat'>('map');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<[number, number, number?] | undefined>(undefined);
  // Quiet "map unavailable offline" pill: set on the doc's debounced tileerror while offline,
  // hidden by the render condition (`&& !online`) as soon as the connection returns.
  const [tilesOffline, setTilesOffline] = useState(false);

  // Basemap choice persists — farmers who recognize their land from the air keep satellite.
  useEffect(() => {
    AsyncStorage.getItem(BASEMAP_KEY)
      .then((v) => {
        if (v === 'sat' || v === 'map') setBasemap(v);
      })
      .catch(() => {});
  }, []);
  const toggleBasemap = () => {
    setBasemap((prev) => {
      const next = prev === 'map' ? 'sat' : 'map';
      AsyncStorage.setItem(BASEMAP_KEY, next).catch(() => {});
      return next;
    });
  };

  const parcels = useMemo(
    () => (parcelsQ.data ?? []).filter((p) => !p.archived),
    [parcelsQ.data],
  );
  const ids = useMemo(() => parcels.map((p) => p.id), [parcels]);
  const latestQ = useLatestIndices(ids);

  const openAlertsQ = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: () => api.get<Alert[]>('/alerts?state=open'),
  });

  // The map always shows EVERY field. Searching only filters the result list below the bar, so
  // the parcel set — and with it the camera (doc-side viewKey) — never changes per keystroke;
  // on first load the document fits the bounds of all org parcels with padding.
  const features: ParcelFeature[] = useMemo(() => {
    const latest = latestQ.data ?? {};
    return parcels.map((parcel) => {
      if (choropleth === 'none') return { parcel, color: 'transparent' };
      if (choropleth === 'score') {
        const score = arvoScoreDetail(latest[parcel.id]).score;
        return { parcel, color: score == null ? NEUTRAL_FILL : scoreColor(score) };
      }
      const mean = latest[parcel.id]?.[choropleth]?.mean ?? null;
      return { parcel, color: mean == null ? NEUTRAL_FILL : indexColor(choropleth, mean) };
    });
  }, [parcels, latestQ.data, choropleth]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return parcels.filter((p) => p.name.toLowerCase().includes(q)).slice(0, MAX_SEARCH_RESULTS);
  }, [query, parcels]);

  // Camera moves ONLY on an explicit pick from the results list — never while typing.
  const pickParcel = (id: string, lon: number, lat: number) => {
    setQuery('');
    setSelectedId(id);
    setFocus([lon, lat, 15]);
  };

  const selected = selectedId ? (parcels.find((p) => p.id === selectedId) ?? null) : null;

  // Selection-card verdict comes from the shared status pipeline ONLY (status.ts): score and
  // coverage via arvoScoreDetail, NDVI trend via trendFromSeries, open events via grouping.
  const ndviSeriesQ = useIndexSeries(selected?.id ?? '', 'ndvi');
  const selectedTrend = useMemo(() => {
    const series = ndviSeriesQ.data?.series;
    if (!series || series.length === 0) return null;
    return trendFromSeries(series.map((pt) => ({ date: pt.observed_at, value: pt.mean })));
  }, [ndviSeriesQ.data]);
  const selectedDetail = selected ? arvoScoreDetail(latestQ.data?.[selected.id]) : null;
  const selectedOpenEvents = useMemo(
    () =>
      selected
        ? countAlertEvents((openAlertsQ.data ?? []).filter((a) => a.parcel_id === selected.id))
        : 0,
    [openAlertsQ.data, selected],
  );
  const fieldStatus =
    selected && selectedDetail
      ? deriveFieldStatus({
          score: selectedDetail.score,
          trend: selectedTrend,
          openAlertEvents: selectedOpenEvents,
          coverage: selectedDetail.coverage,
        })
      : null;
  // theme's StatusChip speaks 'healthy'|'watch'|'attention'; status.ts speaks 'ok' for the first.
  const chipStatus: Status =
    fieldStatus == null || fieldStatus.level === 'ok' ? 'healthy' : fieldStatus.level;

  const selectedMean = selected
    ? choropleth !== 'score' && choropleth !== 'none'
      ? (latestQ.data?.[selected.id]?.[choropleth]?.mean ?? null)
      : (selectedDetail?.score ?? null)
    : null;
  const selectedIsIndex = choropleth !== 'score' && choropleth !== 'none';

  const viewOptions: { key: MapChoropleth; label: string }[] = useMemo(
    () => [
      { key: 'score', label: t('map.score_view') },
      { key: 'none', label: t('map.view_none', { defaultValue: 'Solo confini' }) },
      ...INDEX_NAMES.map((i) => ({
        key: i as MapChoropleth,
        label: `${t(`index.${i}.name`)} (${i.toUpperCase()})`,
      })),
    ],
    [t],
  );

  const legendIndex: IndexName | null = selectedIsIndex ? (choropleth as IndexName) : null;
  const [domainMin, domainMax] = legendIndex ? INDEX_DOMAIN[legendIndex] : [0, 100];
  const gradientStops = useMemo(
    () =>
      Array.from({ length: 5 }, (_, i) =>
        legendIndex
          ? indexColor(legendIndex, domainMin + ((domainMax - domainMin) * i) / 4)
          : scoreColor(domainMin + ((domainMax - domainMin) * i) / 4),
      ),
    [legendIndex, domainMin, domainMax],
  );

  const mapReady = !parcelsQ.isLoading && !parcelsQ.isError;
  const showResults = query.trim().length > 0;
  const newFieldLabel = t('map.new_field', { defaultValue: 'Nuovo campo' });

  return (
    <View style={styles.root}>
      {parcelsQ.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : parcelsQ.isError ? (
        <View style={styles.center}>
          <Text style={styles.msg} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('map.load_error')}
          </Text>
          <InteractivePressable style={styles.retry} onPress={() => parcelsQ.refetch()}>
            <Text style={styles.retryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('common.retry')}
            </Text>
          </InteractivePressable>
        </View>
      ) : (
        <MapView
          parcels={features}
          mode="view"
          focus={focus}
          basemap={basemap}
          onSelectParcel={(id) => setSelectedId(id)}
          onTileError={() => {
            if (!online) setTilesOffline(true);
          }}
        />
      )}

      {mapReady && parcels.length === 0 ? (
        <View style={styles.emptyWrap} pointerEvents="box-none">
          <InteractivePressable
            style={styles.emptyCard}
            onPress={() => router.push('/parcel/new')}
            accessibilityLabel={newFieldLabel}
          >
            <Ionicons name="map-outline" size={28} color={colors.textMuted} />
            <Text style={styles.emptyTxt} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('map.empty')}
            </Text>
            <View style={styles.emptyCta}>
              <Ionicons name="add" size={18} color={colors.onPrimary} />
              <Text style={styles.emptyCtaTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                {newFieldLabel}
              </Text>
            </View>
          </InteractivePressable>
        </View>
      ) : null}

      {parcels.length > 0 && choropleth !== 'none' ? (
        <GlassSurface style={styles.legend} fallbackStyle={styles.legend} pointerEvents="none">
          <Text style={styles.legendTitle} maxFontSizeMultiplier={typeScale.maxMult}>
            {!legendIndex
              ? t('map.score_legend')
              : legendIndex === 'ndvi'
              ? t('map.ndvi_legend')
              : t('map.index_legend', {
                  defaultValue: '{{index}} (latest)',
                  index: legendIndex.toUpperCase(),
                })}
          </Text>
          {!legendIndex ? (
            <View style={styles.legendGradientRow}>
              <Text style={styles.legendLabel} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('map.score_low')}
              </Text>
              <View style={styles.gradientBar}>
                {gradientStops.map((c, i) => (
                  <View key={i} style={[styles.gradientCell, { backgroundColor: c }]} />
                ))}
              </View>
              <Text style={styles.legendLabel} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('map.score_high')}
              </Text>
            </View>
          ) : legendIndex === 'ndvi' ? (
            <View style={styles.legendRow}>
              {LEGEND.map((l) => (
                <View key={l.color} style={styles.legendItem}>
                  <View style={[styles.swatch, { backgroundColor: l.color }]} />
                  <Text style={styles.legendLabel} maxFontSizeMultiplier={typeScale.maxMult}>
                    {l.label ?? t('map.no_data')}
                  </Text>
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
                <Text style={styles.legendLabel} maxFontSizeMultiplier={typeScale.maxMult}>
                  {t('map.no_data')}
                </Text>
              </View>
            </View>
          )}
        </GlassSurface>
      ) : null}

      {selected ? (
        <GlassSurface
          style={styles.selCard}
          fallbackStyle={styles.selCard}
        >
          <View style={styles.selRow}>
            <View
              style={[
                styles.scoreBadge,
                {
                  backgroundColor: selectedIsIndex
                    ? indexColor(choropleth as IndexName, selectedMean)
                    : scoreColor(selectedMean),
                },
              ]}
            >
              <Text style={styles.scoreBadgeValue} maxFontSizeMultiplier={typeScale.maxMult}>
                {selectedMean == null
                  ? '—'
                  : selectedIsIndex
                  ? selectedMean.toFixed(2)
                  : Math.round(selectedMean)}
              </Text>
            </View>
            <View style={styles.selInfo}>
              <Text style={styles.selName} numberOfLines={1} maxFontSizeMultiplier={typeScale.maxMult}>
                {selected.name}
              </Text>
              <Text style={styles.selMeta} numberOfLines={1} maxFontSizeMultiplier={typeScale.maxMult}>
                {[
                  cropLabel(selected.crop),
                  selected.area_ha != null ? formatHectares(selected.area_ha) : null,
                  fieldStatus?.partial ? t('status.partial') : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
            {fieldStatus ? <StatusChip status={chipStatus} label={t(fieldStatus.chipKey)} /> : null}
            <InteractivePressable
              onPress={() => setSelectedId(null)}
              hitSlop={10}
              accessibilityLabel={t('map.close_selection')}
              style={styles.iconButton}
              hoverStyle={styles.iconButtonHover}
            >
              <Ionicons name="close" size={18} color={colors.textMuted} />
            </InteractivePressable>
          </View>
          <View style={styles.selButtons}>
            <InteractivePressable
              style={styles.detailBtn}
              onPress={() => router.push(`/parcel/${selected.id}`)}
              accessibilityLabel={t('map.open_detail')}
            >
              <TintCard gradient={gradients.forest} style={styles.detailBtnInner}>
                <Text style={styles.detailBtnTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                  {t('map.open_detail')}
                </Text>
              </TintCard>
            </InteractivePressable>
            <InteractivePressable
              style={styles.scoutBtn}
              hoverStyle={styles.scoutBtnHover}
              onPress={() => router.push(`/observation/new?parcelId=${selected.id}`)}
              accessibilityLabel={t('map.scout_here')}
            >
              <Text style={styles.scoutBtnTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('map.scout_here')}
              </Text>
            </InteractivePressable>
          </View>
        </GlassSurface>
      ) : null}

      {mapReady ? (
        <View style={[styles.topCol, { top: insets.top + spacing.sm }]} pointerEvents="box-none">
          <View style={styles.topRow} pointerEvents="box-none">
            <GlassSurface style={styles.search} fallbackStyle={styles.search}>
              <Ionicons name="search" size={16} color={colors.textFaint} />
              <TextInput
                style={styles.searchInput}
                value={query}
                onChangeText={setQuery}
                placeholder={t('map.search_fields')}
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                accessibilityLabel={t('map.search_fields')}
                maxFontSizeMultiplier={typeScale.maxMult}
              />
            </GlassSurface>
            {/* ONE control for everything visual: base map + overlay live in the same sheet. */}
            <InteractivePressable
              style={styles.topChip}
              hoverStyle={styles.topChipHover}
              onPress={() => setPickerOpen(true)}
              accessibilityLabel={t('map.layers')}
            >
              <Ionicons name="layers-outline" size={14} color={colors.text} />
              <MonoLabel color={colors.text}>
                {t('map.layers')}
              </MonoLabel>
            </InteractivePressable>
          </View>

          {showResults ? (
            <GlassSurface style={styles.results} fallbackStyle={styles.results}>
              {matches.map((p) => (
                <InteractivePressable
                  key={p.id}
                  style={styles.resultRow}
                  onPress={() => pickParcel(p.id, p.centroid.lon, p.centroid.lat)}
                  accessibilityLabel={p.name}
                >
                  <Ionicons name="location-outline" size={16} color={colors.textMuted} />
                  <Text
                    style={styles.resultName}
                    numberOfLines={1}
                    maxFontSizeMultiplier={typeScale.maxMult}
                  >
                    {p.name}
                  </Text>
                  <Text style={styles.resultMeta} maxFontSizeMultiplier={typeScale.maxMult}>
                    {p.area_ha != null ? formatHectares(p.area_ha) : ''}
                  </Text>
                </InteractivePressable>
              ))}
              {matches.length === 0 ? (
                <View style={styles.resultRow}>
                  <Text style={styles.resultMeta} maxFontSizeMultiplier={typeScale.maxMult}>
                    {t('map.search_no_results', { defaultValue: 'Nessun campo trovato' })}
                  </Text>
                </View>
              ) : null}
            </GlassSurface>
          ) : null}

          <View style={styles.banners} pointerEvents="none">
            <StaleBanner updatedAt={parcelsQ.dataUpdatedAt || null} />
            {tilesOffline && !online ? (
              <View style={styles.tilePill} accessibilityLiveRegion="polite">
                <Ionicons name="cloud-offline-outline" size={14} color={colors.textMuted} />
                <Text style={styles.tileTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                  {t('map.offline_tiles')}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      ) : null}

      <Modal
        visible={pickerOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setPickerOpen(false)}
      >
        <View style={styles.sheetRoot}>
          <Pressable
            style={styles.sheetBackdrop}
            onPress={() => setPickerOpen(false)}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.md }]}>
            <Text style={styles.sheetTitle} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('map.base_title')}
            </Text>
            <View style={styles.baseRow}>
              {(['map', 'sat'] as const).map((b) => {
                const active = basemap === b;
                return (
                  <InteractivePressable
                    key={b}
                    style={[styles.baseBtn, active && styles.baseBtnActive]}
                    onPress={() => {
                      if (!active) toggleBasemap();
                    }}
                    accessibilityLabel={t(b === 'map' ? 'map.basemap_map' : 'map.basemap_sat')}
                    accessibilityState={{ selected: active }}
                  >
                    <Ionicons
                      name={b === 'map' ? 'map-outline' : 'earth-outline'}
                      size={16}
                      color={active ? colors.onPrimary : colors.text}
                    />
                    <Text
                      style={[styles.baseBtnTxt, active && styles.baseBtnTxtActive]}
                      maxFontSizeMultiplier={typeScale.maxMult}
                    >
                      {t(b === 'map' ? 'map.basemap_map' : 'map.basemap_sat')}
                    </Text>
                  </InteractivePressable>
                );
              })}
            </View>
            <Text style={styles.sheetTitle} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('map.overlay_title')}
            </Text>
            {viewOptions.map((v) => {
              const active = v.key === choropleth;
              return (
                <InteractivePressable
                  key={String(v.key)}
                  style={styles.sheetRow}
                  onPress={() => {
                    setChoropleth(v.key);
                    setPickerOpen(false);
                  }}
                  accessibilityLabel={v.label}
                  accessibilityState={{ selected: active }}
                >
                  <Text
                    style={[styles.sheetRowTxt, active && styles.sheetRowTxtActive]}
                    maxFontSizeMultiplier={typeScale.maxMult}
                  >
                    {v.label}
                  </Text>
                  {active ? <Ionicons name="checkmark" size={20} color={colors.primary} /> : null}
                </InteractivePressable>
              );
            })}
          </View>
        </View>
      </Modal>

      {/* No on-map create button: the tab bar's "+" menu owns creation everywhere.
          The empty-state card above keeps its contextual CTA. */}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  msg: { color: colors.textMuted, fontSize: typeScale.bodyLg, fontFamily: fonts.body },
  retry: {
    minHeight: touch.min,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
  },
  retryTxt: { color: colors.onPrimary, fontFamily: fonts.bodySemiBold },
  topCol: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    gap: spacing.sm,
  },
  topRow: {
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
    minHeight: touch.min,
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
  searchInput: {
    flex: 1,
    fontSize: typeScale.body,
    fontFamily: fonts.body,
    color: colors.text,
    paddingVertical: 0,
  },
  topChip: {
    minHeight: touch.min,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
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
  topChipHover: { backgroundColor: colors.cardAlt, borderColor: colors.primary },
  results: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    maxWidth: 420,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  resultRow: {
    minHeight: touch.min,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  resultName: { flex: 1, fontSize: typeScale.bodyLg, fontFamily: fonts.bodyMedium, color: colors.text },
  resultMeta: { fontSize: typeScale.caption, fontFamily: fonts.mono, color: colors.textMuted },
  banners: { alignItems: 'center', gap: spacing.sm },
  tilePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 28,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  tileTxt: { fontFamily: fonts.bodyMedium, fontSize: typeScale.caption, color: colors.textMuted },
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
    maxWidth: 320,
  },
  emptyTxt: {
    color: colors.textMuted,
    fontSize: typeScale.bodyLg,
    fontFamily: fonts.body,
    textAlign: 'center',
  },
  emptyCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: touch.min,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
  },
  emptyCtaTxt: { color: colors.onPrimary, fontSize: typeScale.body, fontFamily: fonts.bodyBold },
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
  legendTitle: {
    fontSize: 11,
    fontFamily: fonts.bodySemiBold,
    color: colors.text,
    marginBottom: 2,
  },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, maxWidth: 230 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  legendLabel: { fontSize: 10, fontFamily: fonts.mono, color: colors.textMuted },
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
  scoreBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scoreBadgeValue: { fontFamily: fonts.monoSemiBold, fontSize: typeScale.caption, color: '#FFFFFF' },
  selInfo: { flex: 1 },
  selName: { fontSize: typeScale.bodyLg, fontFamily: fonts.display, color: colors.text },
  selMeta: { fontSize: 13, fontFamily: fonts.body, color: colors.textMuted, marginTop: 2 },
  selButtons: { flexDirection: 'row', gap: spacing.sm },
  detailBtn: { flex: 1 },
  detailBtnInner: {
    minHeight: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    borderColor: 'transparent',
  },
  detailBtnTxt: { color: colors.onPrimary, fontSize: typeScale.body, fontFamily: fonts.bodyBold },
  scoutBtn: {
    minHeight: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  scoutBtnHover: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  scoutBtnTxt: { color: colors.text, fontSize: typeScale.body, fontFamily: fonts.bodySemiBold },
  iconButton: { padding: 6, borderRadius: radius.sm },
  iconButtonHover: { backgroundColor: colors.cardAlt },
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheetBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(27,30,26,0.35)',
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingTop: spacing.md,
    paddingHorizontal: spacing.md,
    gap: 2,
  },
  baseRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.sm,
  },
  baseBtn: {
    flex: 1,
    minHeight: touch.min,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  baseBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  baseBtnTxt: { fontFamily: fonts.bodySemiBold, fontSize: typeScale.body, color: colors.text },
  baseBtnTxtActive: { color: colors.onPrimary },
  sheetTitle: {
    fontSize: typeScale.title,
    fontFamily: fonts.display,
    color: colors.text,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  sheetRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  sheetRowTxt: { fontSize: typeScale.bodyLg, fontFamily: fonts.body, color: colors.text },
  sheetRowTxtActive: { fontFamily: fonts.bodySemiBold, color: colors.primary },
});

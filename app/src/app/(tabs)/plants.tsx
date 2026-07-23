// OWNER: fe-plant-map — Plants tab (FR-P-051 · FR-P-042 · FR-P-043): the selected parcel's plants
// on the MapLibre PlantMap, coloured by the chosen metric over the parcel-wide scale, with a
// floating parcel + metric selector, the weakest-N panel and the replant list. A tap on the map or
// on a row opens /plant/{id}; the FAB registers a new flight (/capture/new?parcelId=…).
// Full-bleed like (tabs)/map.tsx: the map fills the screen and every control floats over it.
// Terra: no state dots, no left-border stripes, fonts are family tokens (never fontWeight).
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import Ionicons from '@expo/vector-icons/Ionicons';
import { format, parseISO } from 'date-fns';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PLANT_METRICS, type PlantMetric, type ReplantReason } from '@/api/types';
import PlantMap from '@/components/PlantMap';
import { MonoLabel, MonoValue, Pill } from '@/components/ui';
import { dfLocale } from '@/features/insights/format';
import { useParcels } from '@/features/parcels/hooks';
import { plantColor, rampForMetric } from '@/features/plants/colors';
import {
  useCaptures,
  usePlantMetricScale,
  usePlantRanking,
  usePlantSummary,
  usePlantTileUrl,
  useReplantList,
} from '@/features/plants/hooks';
import {
  formatMetricValue,
  formatVsBlock,
  metricLabelKey,
  metricUnitKey,
  plantName,
  weakestN,
} from '@/features/plants/ranking';
import { colors, fonts, radius, severityTint, spacing } from '@/theme';

// Rows kept in each floating panel — the full lists live in the parcel/plant screens.
const PANEL_LIMIT = 8;
// Panel-height guess used for the FAB offset until onLayout reports the real value.
const PANEL_HEIGHT_ESTIMATE = 260;

type Segment = 'weakest' | 'replant';

// Replant reason → chip tint (labelled chip, never a coloured dot — docs/DESIGN.md §5).
const REASON_TINT: Record<ReplantReason, { fg: string; bg: string }> = {
  missing: severityTint.warning,
  dead: severityTint.critical,
  vigor_collapse: severityTint.warning,
};

export default function PlantsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const locale = dfLocale();

  // `?parcelId=` — how the parcel detail screen enters this tab on a specific parcel.
  const { parcelId: paramParcelId } = useLocalSearchParams<{ parcelId?: string }>();

  const parcelsQ = useParcels();
  const parcels = useMemo(() => (parcelsQ.data ?? []).filter((p) => !p.archived), [parcelsQ.data]);

  const [pickedId, setPickedId] = useState<string | null>(null);
  const [metric, setMetric] = useState<PlantMetric>('ndvi');
  const [segment, setSegment] = useState<Segment>('weakest');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [panelHeight, setPanelHeight] = useState(0);

  // An explicit pick wins over the deep link — so the tab is useful without a selection step and
  // a refetch never moves the map. With neither, prefer the parcel of the newest extracted flight
  // (one that actually HAS plants) over "the first parcel": landing on the tab must show real
  // data, not the empty state of a plantless first parcel.
  const capturesQ = useCaptures(undefined, { status: 'extracted', limit: 1 });
  const wantedId = pickedId ?? paramParcelId ?? null;
  const defaultPlantParcelId = capturesQ.data?.[0]?.parcel_id ?? null;
  const parcel = useMemo(
    () =>
      parcels.find((p) => p.id === wantedId) ??
      parcels.find((p) => p.id === defaultPlantParcelId) ??
      parcels[0] ??
      null,
    [parcels, wantedId, defaultPlantParcelId],
  );
  const parcelId = parcel?.id ?? '';

  const tileUrl = usePlantTileUrl(parcelId, metric);
  const scaleQ = usePlantMetricScale(parcelId, metric);
  const summaryQ = usePlantSummary(parcelId);
  const rankingQ = usePlantRanking(parcelId, { metric, limit: PANEL_LIMIT });
  const replantQ = useReplantList(parcelId, { limit: PANEL_LIMIT });

  const scale = scaleQ.data;
  // The tiles' `norm` domain — undefined until a capture has been extracted for this metric.
  const domain =
    scale && scale.p5 != null && scale.p95 != null ? { p5: scale.p5, p95: scale.p95 } : undefined;
  const ramp = rampForMetric(metric);
  const unitKey = metricUnitKey(metric);
  const unit = unitKey ? ` ${t(unitKey)}` : '';

  const weakest = useMemo(
    () => weakestN(rankingQ.data?.page.items ?? [], PANEL_LIMIT),
    [rankingQ.data],
  );
  const replant = replantQ.data?.items ?? [];
  const summary = summaryQ.data;

  const observedAt = scale?.observed_at ?? summary?.last_capture?.captured_at ?? null;
  const legendDate = observedAt
    ? format(parseISO(observedAt), 'd MMM', { locale })
    : t('plants.no_capture');

  function cycleMetric() {
    const i = PLANT_METRICS.indexOf(metric);
    setMetric(PLANT_METRICS[(i + 1) % PLANT_METRICS.length]);
  }

  function openPlant(plantId: string) {
    router.push(`/plant/${plantId}`);
  }

  function openCapture() {
    if (!parcelId) return;
    router.push({ pathname: '/capture/new', params: { parcelId } });
  }

  // Only claim "no plants" once the summary actually came back — a failed request must not read
  // as an empty planting.
  const noPlants = summaryQ.isSuccess && summary?.total === 0;
  const fabBottom = spacing.md + (panelHeight || PANEL_HEIGHT_ESTIMATE) + spacing.sm;

  if (parcelsQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (parcelsQ.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.msg}>{t('map.load_error')}</Text>
        <Pressable style={styles.retry} onPress={() => parcelsQ.refetch()}>
          <Text style={styles.retryTxt}>{t('common.retry')}</Text>
        </Pressable>
      </View>
    );
  }
  if (!parcel) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>{t('dashboard.empty_title')}</Text>
        <Text style={styles.msg}>{t('dashboard.empty_body')}</Text>
        <Pressable style={styles.retry} onPress={() => router.push('/parcel/new')}>
          <Text style={styles.retryTxt}>{t('dashboard.empty_cta')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {tileUrl ? (
        <PlantMap
          parcelId={parcel.id}
          tileUrlTemplate={tileUrl}
          parcelGeometry={parcel.geometry}
          metric={metric}
          scale={domain}
          onSelectPlant={openPlant}
        />
      ) : (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.msg}>{t('plantmap.loading')}</Text>
        </View>
      )}

      {/* parcel + metric selectors */}
      <View style={[styles.topRow, { top: insets.top + spacing.sm }]}>
        <Pressable
          style={({ pressed }) => [styles.parcelChip, pressed && styles.pressed]}
          onPress={() => setPickerOpen((v) => !v)}
        >
          <Ionicons name="leaf-outline" size={15} color={colors.primary} />
          <Text style={styles.parcelChipTxt} numberOfLines={1}>
            {parcel.name}
          </Text>
          <Text style={styles.caret}>▾</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.metricChip, pressed && styles.pressed]}
          onPress={cycleMetric}
          accessibilityLabel={t('plantmap.change_metric')}
        >
          <MonoLabel color={colors.text} size={11}>
            {`${t(metricLabelKey(metric))} ▾`}
          </MonoLabel>
        </Pressable>
      </View>

      {pickerOpen ? (
        <View style={[styles.picker, { top: insets.top + spacing.sm + 48 }]}>
          <ScrollView style={styles.pickerScroll}>
            {parcels.map((p) => {
              const active = p.id === parcel.id;
              return (
                <Pressable
                  key={p.id}
                  style={({ pressed }) => [
                    styles.pickerItem,
                    active && styles.pickerItemActive,
                    pressed && styles.pressed,
                  ]}
                  onPress={() => {
                    setPickedId(p.id);
                    setPickerOpen(false);
                  }}
                >
                  <Text style={[styles.pickerTxt, active && styles.pickerTxtActive]} numberOfLines={1}>
                    {p.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      {/* legend + weakest-N / replant panels */}
      <View style={styles.panel} onLayout={(e) => setPanelHeight(e.nativeEvent.layout.height)}>
        <View style={styles.legendRow}>
          <MonoLabel color={colors.textMuted} size={10}>
            {t('plantmap.legend', { metric: t(metricLabelKey(metric)), date: legendDate })}
          </MonoLabel>
        </View>
        <View style={styles.legendScale}>
          <Text style={styles.legendEdge}>{t('plantmap.legend_low')}</Text>
          <View style={styles.gradientBar}>
            {ramp.map((c) => (
              <View key={c} style={[styles.gradientCell, { backgroundColor: c }]} />
            ))}
          </View>
          <Text style={styles.legendEdge}>{t('plantmap.legend_high')}</Text>
          <View style={styles.flex1} />
          <MonoValue size={10} weight="600" color={colors.textMuted}>
            {domain
              ? `${formatMetricValue(metric, domain.p5)} → ${formatMetricValue(metric, domain.p95)}`
              : t('plantmap.no_data')}
          </MonoValue>
        </View>

        <View style={styles.segRow}>
          <SegButton
            label={t('plants.ranking_weakest')}
            active={segment === 'weakest'}
            onPress={() => setSegment('weakest')}
          />
          <SegButton
            label={t('replant.title')}
            active={segment === 'replant'}
            onPress={() => setSegment('replant')}
          />
          <View style={styles.flex1} />
          {summary ? (
            <MonoLabel>{t('plants.count', { count: summary.total })}</MonoLabel>
          ) : null}
        </View>

        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {noPlants ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyTitle}>{t('plants.empty_title')}</Text>
              <Text style={styles.msg}>{t('plants.empty_body')}</Text>
              <Pressable style={styles.retry} onPress={openCapture}>
                <Text style={styles.retryTxt}>{t('plants.empty_cta')}</Text>
              </Pressable>
            </View>
          ) : segment === 'weakest' ? (
            rankingQ.isLoading ? (
              <ActivityIndicator color={colors.primary} style={styles.pad} />
            ) : weakest.length === 0 ? (
              <Text style={styles.msg}>{t('plants.ranking_empty')}</Text>
            ) : (
              weakest.map((r) => {
                const vs = formatVsBlock(r.vs_block_pct);
                return (
                  <Pressable
                    key={r.plant_id}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                    onPress={() => openPlant(r.plant_id)}
                  >
                    <View
                      style={[
                        styles.swatch,
                        { backgroundColor: plantColor(r.status, metric, r.normalized) },
                      ]}
                    >
                      <Text style={styles.swatchTxt}>{r.rank}</Text>
                    </View>
                    <View style={styles.flex1}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {plantName(r, t('plant.unlabeled'))}
                      </Text>
                      <MonoLabel>
                        {`${formatMetricValue(metric, r.value)}${unit}${
                          vs ? ` · ${t('plants.vs_block')} ${vs}` : ''
                        }`}
                      </MonoLabel>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
                  </Pressable>
                );
              })
            )
          ) : replantQ.isLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.pad} />
          ) : replant.length === 0 ? (
            <Text style={styles.msg}>{t('replant.empty')}</Text>
          ) : (
            replant.map((e) => {
              const tint = REASON_TINT[e.reason];
              return (
                <Pressable
                  key={e.plant_id}
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                  onPress={() => openPlant(e.plant_id)}
                >
                  <View style={styles.flex1}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {plantName(e, t('plant.unlabeled'))}
                    </Text>
                    <MonoLabel>
                      {e.last_seen_at
                        ? `${t('replant.last_seen')} ${format(parseISO(e.last_seen_at), 'd MMM', {
                            locale,
                          })}`
                        : t('replant.never_seen')}
                    </MonoLabel>
                  </View>
                  <Pill label={t(`replant.reason.${e.reason}`)} fg={tint.fg} bg={tint.bg} />
                  <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
                </Pressable>
              );
            })
          )}
        </ScrollView>
      </View>

      <Pressable
        style={[styles.fab, { bottom: fabBottom }]}
        onPress={openCapture}
        accessibilityLabel={t('plants.empty_cta')}
      >
        <Ionicons name="add" size={30} color={colors.onPrimary} />
      </Pressable>
    </View>
  );
}

function SegButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.segBtn, active && styles.segBtnActive, pressed && styles.pressed]}
      onPress={onPress}
    >
      <Text style={[styles.segTxt, active && styles.segTxtActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex1: { flex: 1, minWidth: 0 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.bg,
  },
  msg: { color: colors.textMuted, fontSize: 14, fontFamily: fonts.body, textAlign: 'center' },
  emptyTitle: { color: colors.text, fontSize: 17, fontFamily: fonts.display, textAlign: 'center' },
  emptyBox: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
  retry: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
  },
  retryTxt: { color: colors.onPrimary, fontFamily: fonts.bodySemiBold, fontSize: 14 },
  pad: { paddingVertical: spacing.md },
  pressed: { opacity: 0.7 },

  // floating selectors
  topRow: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  parcelChip: {
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
  parcelChipTxt: { flex: 1, fontSize: 14, fontFamily: fonts.bodySemiBold, color: colors.text },
  caret: { fontSize: 12, fontFamily: fonts.body, color: colors.textFaint },
  metricChip: {
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
  picker: {
    position: 'absolute',
    left: spacing.md,
    maxWidth: 420,
    minWidth: 220,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.xs,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  pickerScroll: { maxHeight: 220 },
  pickerItem: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.sm },
  pickerItemActive: { backgroundColor: colors.primarySoft },
  pickerTxt: { fontSize: 14, fontFamily: fonts.body, color: colors.text },
  pickerTxtActive: { fontFamily: fonts.bodySemiBold, color: colors.primary },

  // bottom panel
  panel: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.md,
    maxHeight: 320,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  legendScale: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  legendEdge: { fontSize: 10, fontFamily: fonts.body, color: colors.textFaint },
  gradientBar: { flexDirection: 'row', borderRadius: 2, overflow: 'hidden' },
  gradientCell: { width: 13, height: 10 },
  segRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  segBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardAlt,
  },
  segBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  segTxt: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.textMuted },
  segTxtActive: { color: colors.onPrimary },
  // bounded so the panel keeps its shape and the list scrolls inside it
  list: { maxHeight: 176, flexGrow: 0 },
  listContent: { gap: spacing.xs, paddingBottom: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.cardAlt,
  },
  swatch: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  swatchTxt: { fontFamily: fonts.monoSemiBold, fontSize: 12, color: '#FFFFFF' },
  rowName: { fontSize: 14, fontFamily: fonts.bodySemiBold, color: colors.text },

  fab: {
    position: 'absolute',
    right: spacing.md,
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

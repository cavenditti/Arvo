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
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PLANT_METRICS, type PlantMetric, type ReplantReason } from '@/api/types';
import NativeSheet from '@/components/NativeSheet';
import PlantMap from '@/components/PlantMap';
import { InteractivePressable, MonoLabel, MonoValue, Pill } from '@/components/ui';
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
  PHYSICAL_METRICS,
  formatVsBlock,
  metricLabelKey,
  metricUnitKey,
  plantName,
  weakestN,
} from '@/features/plants/ranking';
import { formatNumber } from '@/lib/format';
import {
  colors,
  fonts,
  navigationMetrics,
  radius,
  severityTint,
  spacing,
  touch,
  type as typeScale,
} from '@/theme';

// Rows kept in each floating panel — the full lists live in the parcel/plant screens.
const PANEL_LIMIT = 8;
// Panel-height guess used for the FAB offset until onLayout reports the real value.
const PANEL_HEIGHT_ESTIMATE = 260;

// Prefer an actual health index when one exists, then measurements the RGB detector can produce.
// This keeps an RGB-only capture from opening on an empty NDVI view even though plants were found.
const AUTO_METRIC_ORDER: PlantMetric[] = [
  'ndvi',
  'canopy_m2',
  'height_m',
  'ndre',
  'gndvi',
  'ndmi',
  'savi',
];

type Segment = 'weakest' | 'replant';

// Replant reason → chip tint (labelled chip, never a coloured dot — docs/DESIGN.md §5).
const REASON_TINT: Record<ReplantReason, { fg: string; bg: string }> = {
  missing: severityTint.warning,
  dead: severityTint.critical,
  vigor_collapse: severityTint.warning,
};

// Same decimals the server-facing helpers use, rendered through the locale-aware
// formatter (docs/UX-REVAMP.md rule 7): "0,412" in Italian, never "0.412".
const METRIC_DECIMALS: Record<PlantMetric, number> = {
  ndvi: 3,
  ndre: 3,
  gndvi: 3,
  ndmi: 3,
  savi: 3,
  canopy_m2: 1,
  height_m: 2,
};

function metricText(metric: PlantMetric, value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  const digits = METRIC_DECIMALS[metric];
  return formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

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
  const [metricChoice, setMetricChoice] = useState<{
    parcelId: string;
    metric: PlantMetric;
  } | null>(null);
  const [segment, setSegment] = useState<Segment>('weakest');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [metricOpen, setMetricOpen] = useState(false);
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

  const summaryQ = usePlantSummary(parcelId);
  const summary = summaryQ.data;
  const autoMetric = useMemo(
    () =>
      AUTO_METRIC_ORDER.find(
        (candidate) => (summary?.latest[candidate]?.plant_count ?? 0) > 0,
      ) ?? 'ndvi',
    [summary],
  );
  const metric = metricChoice?.parcelId === parcelId ? metricChoice.metric : autoMetric;
  const tileUrl = usePlantTileUrl(parcelId, metric);
  const scaleQ = usePlantMetricScale(parcelId, metric);
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

  const observedAt = scale?.observed_at ?? summary?.last_capture?.captured_at ?? null;
  const legendDate = observedAt
    ? format(parseISO(observedAt), 'd MMM', { locale })
    : t('plants.no_capture');

  // Plain phrase first, technical term in parentheses (docs/DESIGN.md §14):
  // "Vigore (NDVI)", "Superficie chioma (m²)" — existing keys only.
  function metricOptionLabel(m: PlantMetric): string {
    const tech = PHYSICAL_METRICS.includes(m) ? t(`plant.metric_unit.${m}`) : m.toUpperCase();
    return `${t(metricLabelKey(m))} (${tech})`;
  }

  function pickMetric(m: PlantMetric) {
    setMetricChoice({ parcelId, metric: m });
    setMetricOpen(false);
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
  const panelBottom =
    insets.bottom + navigationMetrics.barHeight + navigationMetrics.controlGap + spacing.md;
  const fabBottom = panelBottom + (panelHeight || PANEL_HEIGHT_ESTIMATE) + spacing.sm;
  const selectorTop = insets.top + 56;

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
        <Text style={styles.msg} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('map.load_error')}
        </Text>
        <InteractivePressable style={styles.retry} onPress={() => parcelsQ.refetch()}>
          <Text style={styles.retryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('common.retry')}
          </Text>
        </InteractivePressable>
      </View>
    );
  }
  if (!parcel) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('dashboard.empty_title')}
        </Text>
        <Text style={styles.msg} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('dashboard.empty_body')}
        </Text>
        <InteractivePressable style={styles.retry} onPress={() => router.push('/parcel/new')}>
          <Text style={styles.retryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('dashboard.empty_cta')}
          </Text>
        </InteractivePressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Stack.Screen
        options={{
          title: parcel.name,
          headerTitle: () => (
            <Pressable
              onPress={() => {
                setMetricOpen(false);
                setPickerOpen((open) => !open);
              }}
              accessibilityRole="button"
              accessibilityLabel={`${t('fields.select_field')}: ${parcel.name}`}
              accessibilityState={{ expanded: pickerOpen }}
              hitSlop={8}
              style={({ pressed }) => [styles.headerField, pressed && styles.headerFieldPressed]}
            >
              <Text
                style={styles.headerFieldText}
                numberOfLines={1}
                maxFontSizeMultiplier={typeScale.maxMult}
              >
                {parcel.name}
              </Text>
              <Ionicons
                name={pickerOpen ? 'chevron-up' : 'chevron-down'}
                size={15}
                color={colors.textMuted}
              />
            </Pressable>
          ),
        }}
      />

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
          <Text style={styles.msg} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('plantmap.loading')}
          </Text>
        </View>
      )}

      {/* One compact map row: the field selector now lives in the native navigation title. */}
      <View style={[styles.topRow, { top: selectorTop }]}>
        <InteractivePressable
          haptic
          style={styles.metricChip}
          onPress={() => {
            setPickerOpen(false);
            setMetricOpen(true);
          }}
          accessibilityLabel={`${t('plantmap.change_metric')} · ${metricOptionLabel(metric)}`}
        >
          <Text
            style={styles.metricChipText}
            numberOfLines={1}
            maxFontSizeMultiplier={typeScale.maxMult}
          >
            {metricOptionLabel(metric)}
          </Text>
          <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
        </InteractivePressable>
      </View>

      {pickerOpen ? (
        <View style={[styles.picker, { top: insets.top + 48 }]}>
          <ScrollView style={styles.pickerScroll}>
            {parcels.map((p) => {
              const active = p.id === parcel.id;
              return (
                <InteractivePressable
                  key={p.id}
                  haptic
                  style={[styles.pickerItem, active && styles.pickerItemActive]}
                  accessibilityLabel={p.name}
                  accessibilityState={{ selected: active }}
                  onPress={() => {
                    setPickedId(p.id);
                    setPickerOpen(false);
                  }}
                >
                  <Text
                    style={[styles.pickerTxt, active && styles.pickerTxtActive]}
                    numberOfLines={1}
                    maxFontSizeMultiplier={typeScale.maxMult}
                  >
                    {p.name}
                  </Text>
                </InteractivePressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      {/* metric picker — a real choice, not a blind cycle: plain names first, sigla in parens */}
      <NativeSheet
        visible={metricOpen}
        onClose={() => setMetricOpen(false)}
        closeAccessibilityLabel={t('common.close', { defaultValue: 'Chiudi' })}
        contentStyle={styles.sheet}
      >
        <View>
            <Text style={styles.sheetTitle} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('plant.select_metric')}
            </Text>
            {PLANT_METRICS.map((m) => {
              const active = m === metric;
              return (
                <InteractivePressable
                  key={m}
                  haptic
                  style={styles.sheetRow}
                  accessibilityLabel={metricOptionLabel(m)}
                  accessibilityState={{ selected: active }}
                  onPress={() => pickMetric(m)}
                >
                  <Text
                    style={[styles.sheetRowTxt, active && styles.sheetRowTxtActive]}
                    maxFontSizeMultiplier={typeScale.maxMult}
                  >
                    {metricOptionLabel(m)}
                  </Text>
                  {active ? <Ionicons name="checkmark" size={20} color={colors.primary} /> : null}
                </InteractivePressable>
              );
            })}
        </View>
      </NativeSheet>

      {/* legend + weakest-N / replant panels */}
      <View
        style={[styles.panel, { bottom: panelBottom }]}
        onLayout={(e) => setPanelHeight(e.nativeEvent.layout.height)}
      >
        <View style={styles.legendRow}>
          <MonoLabel color={colors.textMuted}>
            {t('plantmap.legend', { metric: t(metricLabelKey(metric)), date: legendDate })}
          </MonoLabel>
        </View>
        <View style={styles.legendScale}>
          <Text style={styles.legendEdge} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('plantmap.legend_low')}
          </Text>
          <View style={styles.gradientBar}>
            {ramp.map((c) => (
              <View key={c} style={[styles.gradientCell, { backgroundColor: c }]} />
            ))}
          </View>
          <Text style={styles.legendEdge} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('plantmap.legend_high')}
          </Text>
          <View style={styles.flex1} />
          <MonoValue size={typeScale.caption} weight="600" color={colors.textMuted}>
            {domain
              ? `${metricText(metric, domain.p5)} → ${metricText(metric, domain.p95)}`
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
              <Text style={styles.emptyTitle} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('plants.empty_title')}
              </Text>
              <Text style={styles.msg} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('plants.empty_body')}
              </Text>
              <InteractivePressable style={styles.retry} onPress={openCapture}>
                <Text style={styles.retryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                  {t('plants.empty_cta')}
                </Text>
              </InteractivePressable>
            </View>
          ) : segment === 'weakest' ? (
            rankingQ.isLoading ? (
              <ActivityIndicator color={colors.primary} style={styles.pad} />
            ) : weakest.length === 0 ? (
              <Text style={styles.msg} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('plants.ranking_empty')}
              </Text>
            ) : (
              weakest.map((r) => {
                const vs = formatVsBlock(r.vs_block_pct);
                const rowName = plantName(r, t('plant.unlabeled'));
                return (
                  <InteractivePressable
                    key={r.plant_id}
                    style={styles.row}
                    accessibilityLabel={`${rowName} · ${t('plants.open_plant')}`}
                    onPress={() => openPlant(r.plant_id)}
                  >
                    <View
                      style={[
                        styles.swatch,
                        { backgroundColor: plantColor(r.status, metric, r.normalized) },
                      ]}
                    >
                      <Text style={styles.swatchTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                        {r.rank}
                      </Text>
                    </View>
                    <View style={styles.flex1}>
                      <Text
                        style={styles.rowName}
                        numberOfLines={1}
                        maxFontSizeMultiplier={typeScale.maxMult}
                      >
                        {rowName}
                      </Text>
                      <MonoLabel>
                        {`${metricText(metric, r.value)}${unit}${
                          vs ? ` · ${t('plants.vs_block')} ${vs}` : ''
                        }`}
                      </MonoLabel>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
                  </InteractivePressable>
                );
              })
            )
          ) : replantQ.isLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.pad} />
          ) : replant.length === 0 ? (
            <Text style={styles.msg} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('replant.empty')}
            </Text>
          ) : (
            replant.map((e) => {
              const tint = REASON_TINT[e.reason];
              const rowName = plantName(e, t('plant.unlabeled'));
              return (
                <InteractivePressable
                  key={e.plant_id}
                  style={styles.row}
                  accessibilityLabel={`${rowName} · ${t('replant.open_plant')}`}
                  onPress={() => openPlant(e.plant_id)}
                >
                  <View style={styles.flex1}>
                    <Text
                      style={styles.rowName}
                      numberOfLines={1}
                      maxFontSizeMultiplier={typeScale.maxMult}
                    >
                      {rowName}
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
                </InteractivePressable>
              );
            })
          )}
        </ScrollView>
      </View>

      <InteractivePressable
        style={[styles.fab, { bottom: fabBottom }]}
        onPress={openCapture}
        accessibilityLabel={t('plants.empty_cta')}
      >
        <Ionicons name="add" size={30} color={colors.onPrimary} />
      </InteractivePressable>
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
    <InteractivePressable
      haptic
      style={[styles.segBtn, active && styles.segBtnActive]}
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
    >
      <Text style={[styles.segTxt, active && styles.segTxtActive]} maxFontSizeMultiplier={typeScale.maxMult}>
        {label}
      </Text>
    </InteractivePressable>
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
  msg: { color: colors.textMuted, fontSize: typeScale.body, fontFamily: fonts.body, textAlign: 'center' },
  emptyTitle: { color: colors.text, fontSize: 17, fontFamily: fonts.display, textAlign: 'center' },
  emptyBox: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
  retry: {
    minHeight: touch.min,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
  },
  retryTxt: { color: colors.onPrimary, fontFamily: fonts.bodySemiBold, fontSize: typeScale.body },
  pad: { paddingVertical: spacing.md },

  // floating selectors
  headerField: {
    maxWidth: 230,
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
  },
  headerFieldPressed: { backgroundColor: colors.cardAlt },
  headerFieldText: {
    flexShrink: 1,
    color: colors.text,
    fontFamily: fonts.bodySemiBold,
    fontSize: 17,
  },
  topRow: {
    position: 'absolute',
    left: spacing.md,
    right: 116,
    flexDirection: 'row',
    alignItems: 'center',
  },
  metricChip: {
    flex: 1,
    maxWidth: 260,
    flexDirection: 'row',
    gap: spacing.xs,
    minHeight: touch.chip,
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
  metricChipText: {
    flexShrink: 1,
    color: colors.text,
    fontFamily: fonts.bodySemiBold,
    fontSize: typeScale.caption,
  },
  picker: {
    position: 'absolute',
    left: spacing.xl,
    right: spacing.xl,
    maxWidth: 440,
    alignSelf: 'center',
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.xs,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
    zIndex: 10,
  },
  pickerScroll: { maxHeight: 264 },
  pickerItem: {
    minHeight: touch.min,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  pickerItemActive: { backgroundColor: colors.primarySoft },
  pickerTxt: { fontSize: typeScale.body, fontFamily: fonts.body, color: colors.text },
  pickerTxtActive: { fontFamily: fonts.bodySemiBold, color: colors.primary },

  sheet: {
    paddingTop: spacing.md,
    gap: spacing.xs,
  },
  sheetTitle: {
    fontSize: typeScale.title,
    fontFamily: fonts.display,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  sheetRow: {
    minHeight: touch.min,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
  },
  sheetRowTxt: { fontSize: typeScale.bodyLg, fontFamily: fonts.body, color: colors.text },
  sheetRowTxtActive: { fontFamily: fonts.bodySemiBold, color: colors.primary },

  // bottom panel
  panel: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    maxHeight: 340,
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
  legendEdge: { fontSize: typeScale.caption, fontFamily: fonts.body, color: colors.textMuted },
  gradientBar: { flexDirection: 'row', borderRadius: 2, overflow: 'hidden' },
  gradientCell: { width: 13, height: 10 },
  segRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  segBtn: {
    minHeight: touch.min,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardAlt,
  },
  segBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  segTxt: { fontSize: typeScale.caption, fontFamily: fonts.bodySemiBold, color: colors.textMuted },
  segTxtActive: { color: colors.onPrimary },
  // bounded so the panel keeps its shape and the list scrolls inside it
  list: { maxHeight: 176, flexGrow: 0 },
  listContent: { gap: spacing.xs, paddingBottom: spacing.xs },
  row: {
    minHeight: touch.min,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.cardAlt,
  },
  swatch: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  swatchTxt: { fontFamily: fonts.monoSemiBold, fontSize: typeScale.caption, color: '#FFFFFF' },
  rowName: { fontSize: typeScale.body, fontFamily: fonts.bodySemiBold, color: colors.text },

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

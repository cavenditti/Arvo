// OWNER: fe-plant-map — Campo web "Plants" workspace (FR-P-051 · FR-P-042 · FR-P-043). Renders
// inside (tabs)/_layout.web.tsx PortalShell (sidebar + bounded field workspace), so this file is
// content only and its map and contextual side panel scroll independently below a stable header.
// Same data and helpers as the native plants.tsx: parcel + metric selector driving the MapLibre
// PlantMap over the parcel-wide metric scale, the weakest-N ranking and the replant list; a row or
// a tap on the map opens /plant/{id}, and "register a flight" opens /capture/new?parcelId=…
// Terra: no state dots, no left-border stripes, fonts are family tokens (never fontWeight).
import { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import Ionicons from '@expo/vector-icons/Ionicons';
import { format, parseISO } from 'date-fns';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { PLANT_METRICS, type PlantMetric, type ReplantReason } from '@/api/types';
import PlantMap from '@/components/PlantMap';
import { InteractivePressable, MonoLabel, MonoValue, Pill } from '@/components/ui';
import FieldWorkspaceHeader from '@/components/web/FieldWorkspaceHeader';
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
import { colors, fonts, radius, severityTint, spacing, WEB_COMPACT_BREAKPOINT } from '@/theme';

// Keep the contextual rail deliberately short; it scrolls independently from the map workspace.
const LIST_LIMIT = 8;
const MAP_HEIGHT = 460;

// Replant reason → chip tint (labelled chip, never a coloured dot — docs/DESIGN.md §5).
const REASON_TINT: Record<ReplantReason, { fg: string; bg: string }> = {
  missing: severityTint.warning,
  dead: severityTint.critical,
  vigor_collapse: severityTint.warning,
};

export default function PlantsWebScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const locale = dfLocale();
  const { width } = useWindowDimensions();
  const compact = width < WEB_COMPACT_BREAKPOINT;
  const mapHeight = compact ? 320 : MAP_HEIGHT;
  const ColumnContainer = compact ? View : ScrollView;

  // `?parcelId=` — how the parcel detail screen enters this workspace on a specific parcel.
  const { parcelId: paramParcelId } = useLocalSearchParams<{ parcelId?: string }>();

  const parcelsQ = useParcels();
  const parcels = useMemo(() => (parcelsQ.data ?? []).filter((p) => !p.archived), [parcelsQ.data]);

  const [metric, setMetric] = useState<PlantMetric>('ndvi');
  const [sidePanel, setSidePanel] = useState<'weakest' | 'replant'>('weakest');

  // Prefer the deep-linked field, then the parcel of the newest extracted flight, then the first
  // available field. FieldWorkspaceHeader owns subsequent field changes by updating the route.
  const capturesQ = useCaptures(undefined, { status: 'extracted', limit: 1 });
  const wantedId = paramParcelId ?? null;
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
  const rankingQ = usePlantRanking(parcelId, { metric, limit: LIST_LIMIT });
  const replantQ = useReplantList(parcelId, { limit: LIST_LIMIT });

  const scale = scaleQ.data;
  const domain =
    scale && scale.p5 != null && scale.p95 != null ? { p5: scale.p5, p95: scale.p95 } : undefined;
  const ramp = rampForMetric(metric);
  const unitKey = metricUnitKey(metric);
  const unit = unitKey ? ` ${t(unitKey)}` : '';

  const weakest = useMemo(
    () => weakestN(rankingQ.data?.page.items ?? [], LIST_LIMIT),
    [rankingQ.data],
  );
  const replant = replantQ.data?.items ?? [];
  const summary = summaryQ.data;

  const observedAt = scale?.observed_at ?? summary?.last_capture?.captured_at ?? null;
  const legendDate = observedAt
    ? format(parseISO(observedAt), 'd MMM yyyy', { locale })
    : t('plants.no_capture');

  function openPlant(plantId: string) {
    router.push(`/plant/${plantId}`);
  }

  function openCapture() {
    router.push(
      parcelId ? { pathname: '/capture/new', params: { parcelId } } : { pathname: '/capture/new' },
    );
  }

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
        <Text style={styles.muted}>{t('map.load_error')}</Text>
        <InteractivePressable style={styles.primaryBtn} onPress={() => parcelsQ.refetch()}>
          <Text style={styles.primaryTxt}>{t('common.retry')}</Text>
        </InteractivePressable>
      </View>
    );
  }
  if (!parcel) {
    return (
      <View style={styles.center}>
        <Text style={styles.h2}>{t('dashboard.empty_title')}</Text>
        <Text style={styles.muted}>{t('dashboard.empty_body')}</Text>
        <InteractivePressable style={styles.primaryBtn} onPress={() => router.push('/parcel/new')}>
          <Text style={styles.primaryTxt}>{t('dashboard.empty_cta')}</Text>
        </InteractivePressable>
      </View>
    );
  }

  // Only claim "no plants" once the summary actually came back — a failed request must not read
  // as an empty planting.
  const noPlants = summaryQ.isSuccess && summary?.total === 0;

  return (
    <View style={[styles.root, compact && styles.rootCompact]}>
      <FieldWorkspaceHeader parcel={parcel} active="plants" />

      {/* metric tabs + capture meta */}
      <View style={styles.metricRow}>
        {PLANT_METRICS.map((m) => {
          const active = m === metric;
          return (
            <InteractivePressable
              key={m}
              onPress={() => setMetric(m)}
              style={[styles.metricTab, active && styles.metricTabActive]}
              hoverStyle={!active ? styles.controlHover : undefined}
            >
              <Text style={[styles.metricTabTxt, active && styles.metricTabTxtActive]}>
                {t(metricLabelKey(m))}
              </Text>
            </InteractivePressable>
          );
        })}
      </View>

      <View style={[styles.grid, compact && styles.gridCompact]}>
        {/* LEFT — the map */}
        <ColumnContainer
          style={[styles.colLeft, compact && styles.colCompact]}
        >
          <View style={styles.columnContent}>
          <View style={styles.mapCard}>
            {tileUrl ? (
              <PlantMap
                parcelId={parcel.id}
                tileUrlTemplate={tileUrl}
                parcelGeometry={parcel.geometry}
                metric={metric}
                scale={domain}
                height={mapHeight}
                onSelectPlant={openPlant}
              />
            ) : (
              <View style={[styles.mapLoading, { height: mapHeight }]}>
                <ActivityIndicator color={colors.primary} />
                <Text style={styles.muted}>{t('plantmap.loading')}</Text>
              </View>
            )}
          </View>

          <View style={styles.legendCard}>
            <MonoLabel color={colors.textMuted}>
              {t('plantmap.legend', { metric: t(metricLabelKey(metric)), date: legendDate })}
            </MonoLabel>
            <View style={styles.legendScale}>
              <Text style={styles.legendEdge}>{t('plantmap.legend_low')}</Text>
              <View style={styles.gradientBar}>
                {ramp.map((c) => (
                  <View key={c} style={[styles.gradientCell, { backgroundColor: c }]} />
                ))}
              </View>
              <Text style={styles.legendEdge}>{t('plantmap.legend_high')}</Text>
              <View style={styles.flex1} />
              <MonoValue size={11} weight="600" color={colors.textMuted}>
                {domain
                  ? `${formatMetricValue(metric, domain.p5)} → ${formatMetricValue(
                      metric,
                      domain.p95,
                    )}${unit}`
                  : t('plantmap.no_scale')}
              </MonoValue>
            </View>
            <Text style={styles.attribution}>{t('plantmap.attribution')}</Text>
          </View>
          <Text style={styles.disclaimer}>{t('common.decision_support')}</Text>
          </View>
        </ColumnContainer>

        {/* RIGHT — one bounded contextual panel at a time */}
        <View style={[styles.colRight, compact && styles.colCompact]}>
          <View style={[styles.card, styles.sideCard, compact && styles.sideCardCompact]}>
            <View style={styles.sideTabs}>
              <InteractivePressable
                style={[styles.sideTab, sidePanel === 'weakest' && styles.sideTabActive]}
                hoverStyle={sidePanel !== 'weakest' ? styles.sideTabHover : undefined}
                onPress={() => setSidePanel('weakest')}
              >
                <Text style={[styles.sideTabText, sidePanel === 'weakest' && styles.sideTabTextActive]}>
                  {t('plants.ranking_weakest')}
                </Text>
                {summary ? (
                  <MonoLabel color={sidePanel === 'weakest' ? colors.onPrimary : colors.textMuted}>
                    {summary.total}
                  </MonoLabel>
                ) : null}
              </InteractivePressable>
              <InteractivePressable
                style={[styles.sideTab, sidePanel === 'replant' && styles.sideTabActive]}
                hoverStyle={sidePanel !== 'replant' ? styles.sideTabHover : undefined}
                onPress={() => setSidePanel('replant')}
              >
                <Text style={[styles.sideTabText, sidePanel === 'replant' && styles.sideTabTextActive]}>
                  {t('replant.title')}
                </Text>
                {replantQ.data ? (
                  <MonoLabel color={sidePanel === 'replant' ? colors.onPrimary : colors.textMuted}>
                    {replantQ.data.total}
                  </MonoLabel>
                ) : null}
              </InteractivePressable>
            </View>
            <ColumnContainer style={styles.sideScroll}>
              <View style={styles.sideContent}>
              {sidePanel === 'weakest' ? (
                noPlants ? (
                  <View style={styles.emptyBox}>
                    <Text style={styles.h2}>{t('plants.empty_title')}</Text>
                    <Text style={styles.muted}>{t('plants.empty_body')}</Text>
                    <InteractivePressable style={styles.primaryBtn} onPress={openCapture}>
                      <Text style={styles.primaryTxt}>{t('plants.empty_cta')}</Text>
                    </InteractivePressable>
                  </View>
                ) : rankingQ.isLoading ? (
                  <ActivityIndicator color={colors.primary} style={styles.pad} />
                ) : weakest.length === 0 ? (
                  <Text style={styles.muted}>{t('plants.ranking_empty')}</Text>
                ) : (
                  <View style={styles.list}>
                    {weakest.map((r) => {
                      const vs = formatVsBlock(r.vs_block_pct);
                      return (
                        <InteractivePressable
                          key={r.plant_id}
                          style={styles.row}
                          hoverStyle={styles.rowHover}
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
                        </InteractivePressable>
                      );
                    })}
                  </View>
                )
              ) : (
                <>
                  <Text style={styles.hint}>{t('replant.subtitle')}</Text>
                  {replantQ.isLoading ? (
                    <ActivityIndicator color={colors.primary} style={styles.pad} />
                  ) : replant.length === 0 ? (
                    <Text style={styles.muted}>{t('replant.empty')}</Text>
                  ) : (
                    <View style={styles.list}>
                      {replant.map((e) => {
                        const tint = REASON_TINT[e.reason];
                        return (
                          <InteractivePressable
                            key={e.plant_id}
                            style={styles.row}
                            hoverStyle={styles.rowHover}
                            onPress={() => openPlant(e.plant_id)}
                          >
                            <View style={styles.flex1}>
                              <Text style={styles.rowName} numberOfLines={1}>
                                {plantName(e, t('plant.unlabeled'))}
                              </Text>
                              <MonoLabel>
                                {e.last_seen_at
                                  ? `${t('replant.last_seen')} ${format(parseISO(e.last_seen_at), 'd MMM', { locale })}`
                                  : t('replant.never_seen')}
                              </MonoLabel>
                            </View>
                            <Pill label={t(`replant.reason.${e.reason}`)} fg={tint.fg} bg={tint.bg} />
                            <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
                          </InteractivePressable>
                        );
                      })}
                    </View>
                  )}
                </>
              )}
              </View>
            </ColumnContainer>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, gap: spacing.md },
  rootCompact: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
  flex1: { flex: 1, minWidth: 0 },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xl * 3,
  },

  h2: { fontFamily: fonts.display, fontSize: 17, color: colors.text },

  // metric tabs
  metricRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  metricTab: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  metricTabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  metricTabTxt: { fontSize: 12, fontFamily: fonts.monoSemiBold, color: colors.textMuted },
  metricTabTxtActive: { color: colors.onPrimary },

  // grid
  grid: { flex: 1, minHeight: 0, flexDirection: 'row', gap: spacing.lg, alignItems: 'stretch' },
  gridCompact: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', flexDirection: 'column', gap: spacing.md },
  colLeft: { flex: 1.7, minWidth: 420, minHeight: 0 },
  columnContent: { gap: spacing.md, paddingBottom: spacing.sm },
  colRight: { flex: 1, minWidth: 300, minHeight: 0 },
  colCompact: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', minWidth: 0, width: '100%' },

  // map
  mapCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  mapLoading: { alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  legendCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  legendScale: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  legendEdge: { fontSize: 11, fontFamily: fonts.body, color: colors.textFaint },
  gradientBar: { flexDirection: 'row', borderRadius: 2, overflow: 'hidden' },
  gradientCell: { width: 16, height: 10 },
  attribution: { fontSize: 11, fontFamily: fonts.body, color: colors.textFaint },

  // cards + rows
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  sideCard: { flex: 1, minHeight: 0 },
  sideCardCompact: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
  sideTabs: {
    flexDirection: 'row',
    gap: 4,
    padding: 4,
    borderRadius: radius.md,
    backgroundColor: colors.cardAlt,
  },
  sideTab: {
    flex: 1,
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  sideTabActive: { backgroundColor: colors.primary },
  sideTabHover: { backgroundColor: colors.card },
  sideTabText: { fontSize: 12, fontFamily: fonts.bodySemiBold, color: colors.textMuted },
  sideTabTextActive: { color: colors.onPrimary },
  sideScroll: { flex: 1, minHeight: 0 },
  sideContent: { gap: spacing.sm, paddingTop: spacing.xs, paddingBottom: spacing.xs },
  hint: { fontSize: 12.5, lineHeight: 18, fontFamily: fonts.body, color: colors.textMuted },
  list: { gap: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  rowHover: { backgroundColor: colors.card, borderColor: colors.border },
  swatch: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  swatchTxt: { fontFamily: fonts.monoSemiBold, fontSize: 12, color: '#FFFFFF' },
  rowName: { fontSize: 14, fontFamily: fonts.bodySemiBold, color: colors.text },
  emptyBox: { alignItems: 'flex-start', gap: spacing.sm, paddingVertical: spacing.sm },
  controlHover: { backgroundColor: colors.cardAlt, borderColor: colors.primary },

  // shared
  muted: { color: colors.textMuted, fontFamily: fonts.body, fontSize: 14 },
  pad: { paddingVertical: spacing.md },
  primaryBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
  },
  primaryTxt: { color: colors.onPrimary, fontFamily: fonts.bodySemiBold, fontSize: 14 },
  disclaimer: { color: colors.textFaint, fontFamily: fonts.body, fontSize: 11 },
});

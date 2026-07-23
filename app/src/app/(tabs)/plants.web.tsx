// OWNER: fe-plant-map — Campo web "Plants" workspace (FR-P-051 · FR-P-042 · FR-P-043). Renders
// inside (tabs)/_layout.web.tsx PortalShell (sidebar + padded, max-width-1280 scroll area), so this
// file is content only and the map lives in a fixed-height card instead of full-bleed.
// Same data and helpers as the native plants.tsx: parcel + metric selector driving the MapLibre
// PlantMap over the parcel-wide metric scale, the weakest-N ranking and the replant list; a row or
// a tap on the map opens /plant/{id}, and "register a flight" opens /capture/new?parcelId=…
// Terra: no state dots, no left-border stripes, fonts are family tokens (never fontWeight).
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import Ionicons from '@expo/vector-icons/Ionicons';
import { format, parseISO } from 'date-fns';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { PLANT_METRICS, type PlantMetric, type ReplantReason } from '@/api/types';
import PlantMap from '@/components/PlantMap';
import { InteractivePressable, MonoLabel, MonoValue, Pill, TintCard } from '@/components/ui';
import FieldViewSwitcher from '@/components/web/FieldViewSwitcher';
import { useOutsideDismiss } from '@/components/useOutsideDismiss';
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
import { colors, fonts, gradients, radius, severityTint, spacing } from '@/theme';

// The portal shows a longer list than the phone panel, still paged server-side.
const LIST_LIMIT = 12;
const MAP_HEIGHT = 520;

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

  // `?parcelId=` — how the parcel detail screen enters this workspace on a specific parcel.
  const { parcelId: paramParcelId } = useLocalSearchParams<{ parcelId?: string }>();

  const parcelsQ = useParcels();
  const parcels = useMemo(() => (parcelsQ.data ?? []).filter((p) => !p.archived), [parcelsQ.data]);

  const [pickedId, setPickedId] = useState<string | null>(null);
  const [metric, setMetric] = useState<PlantMetric>('ndvi');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<View | null>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useOutsideDismiss(menuRef, menuOpen, closeMenu);

  // An explicit pick wins over the deep link. With neither, prefer the parcel of the newest
  // extracted flight (one that actually HAS plants) over "the first parcel" — landing here from
  // the nav must show real data, not the empty state of a plantless first parcel.
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
    <View style={styles.root}>
      <View style={styles.crumbRow}>
        <InteractivePressable
          style={styles.crumbLink}
          hoverStyle={styles.linkHover}
          onPress={() => router.push('/')}
        >
          <Ionicons name="arrow-back" size={15} color={colors.textMuted} />
          <Text style={styles.crumbLinkTxt}>{t('tabs.dashboard')}</Text>
        </InteractivePressable>
        <Text style={styles.crumbSep}>/</Text>
        <Text style={styles.crumbCurrent} numberOfLines={1}>{parcel.name}</Text>
      </View>

      {/* header */}
      <View style={styles.header}>
        <View style={styles.flex1}>
          <Text style={styles.h1}>{parcel.name}</Text>
          <Text style={styles.subtitle}>{t('plants.subtitle')}</Text>
        </View>
        <View style={styles.headerRight}>
          <View ref={menuRef} style={styles.menuWrap}>
            <InteractivePressable
              style={styles.menuTrigger}
              hoverStyle={styles.controlHover}
              accessibilityState={{ expanded: menuOpen }}
              onPress={() => setMenuOpen((v) => !v)}
            >
              <Ionicons name="leaf-outline" size={15} color={colors.primary} />
              <Text style={styles.menuTriggerTxt} numberOfLines={1}>
                {parcel.name}
              </Text>
              <Ionicons name={menuOpen ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textFaint} />
            </InteractivePressable>
            {menuOpen ? (
              <View style={styles.menu}>
                {parcels.map((p) => (
                  <InteractivePressable
                    key={p.id}
                    style={[styles.menuItem, p.id === parcel.id && styles.menuItemActive]}
                    hoverStyle={p.id !== parcel.id ? styles.menuItemHover : undefined}
                    onPress={() => {
                      setPickedId(p.id);
                      setMenuOpen(false);
                    }}
                  >
                    <Text
                      style={[styles.menuItemTxt, p.id === parcel.id && styles.menuItemTxtActive]}
                      numberOfLines={1}
                    >
                      {p.name}
                    </Text>
                  </InteractivePressable>
                ))}
              </View>
            ) : null}
          </View>
          <InteractivePressable onPress={openCapture}>
            <TintCard gradient={gradients.forest} style={styles.ctaBtn}>
              <Ionicons name="add" size={16} color={colors.onPrimary} />
              <Text style={styles.ctaTxt}>{t('plants.empty_cta')}</Text>
            </TintCard>
          </InteractivePressable>
        </View>
      </View>

      <FieldViewSwitcher parcelId={parcel.id} active="plants" />

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
        <View style={styles.flex1} />
        <MonoLabel color={colors.textMuted}>
          {`${t('plants.last_capture')} · ${legendDate}`}
        </MonoLabel>
      </View>

      <View style={styles.grid}>
        {/* LEFT — the map */}
        <View style={styles.colLeft}>
          <View style={styles.mapCard}>
            {tileUrl ? (
              <PlantMap
                parcelId={parcel.id}
                tileUrlTemplate={tileUrl}
                parcelGeometry={parcel.geometry}
                metric={metric}
                scale={domain}
                height={MAP_HEIGHT}
                onSelectPlant={openPlant}
              />
            ) : (
              <View style={[styles.mapLoading, { height: MAP_HEIGHT }]}>
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
        </View>

        {/* RIGHT — weakest-N + replant */}
        <View style={styles.colRight}>
          <View style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle}>{t('plants.ranking_weakest')}</Text>
              {summary ? <MonoLabel>{t('plants.count', { count: summary.total })}</MonoLabel> : null}
            </View>
            {noPlants ? (
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
            )}
          </View>

          <View style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle}>{t('replant.title')}</Text>
              {replantQ.data ? (
                <MonoLabel>{t('replant.count', { count: replantQ.data.total })}</MonoLabel>
              ) : null}
            </View>
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
                })}
              </View>
            )}
          </View>
        </View>
      </View>

      <Text style={styles.disclaimer}>{t('common.decision_support')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  flex1: { flex: 1, minWidth: 0 },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xl * 3,
  },

  // header
  crumbRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 0 },
  crumbLink: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: radius.sm },
  crumbLinkTxt: { fontSize: 13, fontFamily: fonts.bodyMedium, color: colors.textMuted },
  crumbSep: { fontSize: 13, fontFamily: fonts.body, color: colors.textFaint },
  crumbCurrent: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.text, flexShrink: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, zIndex: 20 },
  h1: { fontFamily: fonts.displayBold, fontSize: 28, color: colors.text, letterSpacing: -0.5 },
  h2: { fontFamily: fonts.display, fontSize: 17, color: colors.text },
  subtitle: { fontFamily: fonts.body, fontSize: 12.5, color: colors.textFaint, marginTop: 2 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  menuWrap: { position: 'relative', zIndex: 20 },
  menuTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    maxWidth: 240,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: 7,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  menuTriggerTxt: { flexShrink: 1, fontFamily: fonts.bodySemiBold, fontSize: 12.5, color: colors.text },
  menu: {
    position: 'absolute',
    top: 40,
    right: 0,
    minWidth: 210,
    maxHeight: 320,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.xs,
    gap: 1,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  menuItem: { paddingHorizontal: spacing.sm + 4, paddingVertical: 7, borderRadius: radius.sm },
  menuItemHover: { backgroundColor: colors.cardAlt },
  menuItemActive: { backgroundColor: colors.primarySoft },
  menuItemTxt: { fontFamily: fonts.body, fontSize: 12.5, color: colors.text },
  menuItemTxtActive: { fontFamily: fonts.bodySemiBold, color: colors.primary },
  ctaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 0,
  },
  ctaTxt: { fontSize: 13, fontFamily: fonts.bodyBold, color: colors.onPrimary },

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
  grid: { flexDirection: 'row', gap: spacing.lg, alignItems: 'flex-start', flexWrap: 'wrap' },
  colLeft: { flex: 1.7, minWidth: 420, gap: spacing.md },
  colRight: { flex: 1, minWidth: 300, gap: spacing.md },

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
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  cardTitle: { fontSize: 15, fontFamily: fonts.display, color: colors.text },
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
  linkHover: { backgroundColor: colors.cardAlt },

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

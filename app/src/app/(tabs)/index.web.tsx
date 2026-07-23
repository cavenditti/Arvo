// OWNER: web-fields — Fields overview for the "Campo" desktop portal (mock screen 01). Web-only
// sibling of index.tsx; the (tabs) web layout wraps this in the portal shell (sidebar + centered
// scrollable main), so this file renders page content only — no sidebar. Query keys mirror the
// native screens (parcels / indices latest / alerts open / per-parcel ndvi spark) so the
// react-query cache is shared across platforms.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQueries, useQuery } from '@tanstack/react-query';
import { format, formatDistanceToNow, parseISO } from 'date-fns';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';

import { api } from '@/api/client';
import { INDEX_NAMES } from '@/api/types';
import type { Alert, IndexName, IndexPoint, LatestIndices, Org } from '@/api/types';
import { kindGlyph } from '@/components/glyphs';
import MapView from '@/components/MapView';
import type { ParcelFeature } from '@/components/types';
import { Card, GlyphBadge, GlyphCard, InteractivePressable, MonoLabel, MonoValue, Pill, StatusChip } from '@/components/ui';
import { sortBySeverityThenRecency, worstSeverityByParcel } from '@/features/insights/alerts';
import {
  INDEX_DOMAIN,
  arvoScore,
  cropLabel,
  dfLocale,
  indexColor,
  scoreBand,
  scoreColor,
  trendBand,
} from '@/features/insights/format';
import { lastPassDelta, sevenDayDelta } from '@/features/insights/series';
import { NEUTRAL_FILL } from '@/features/parcels/crops';
import { useLatestIndices, useParcels } from '@/features/parcels/hooks';
import { useParcelNames } from '@/features/parcels/names';
import {
  colors,
  fonts,
  radius,
  severityTint,
  spacing,
  statusColors,
  statusForSeverity,
  statusGradient,
  type Status,
} from '@/theme';

type Me = { org: Org };
type LatestBatch = Record<string, LatestIndices>;
type Spark = { index: IndexName; series: IndexPoint[] };

const DAY_MS = 86_400_000;
const MAP_HEIGHT = 380;
const STATUS_ORDER: Status[] = ['healthy', 'watch', 'attention'];

export default function FieldsWeb() {
  const { t } = useTranslation();
  const router = useRouter();

  const [selectedIndex, setSelectedIndex] = useState<IndexName | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [search, setSearch] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [renderedAt] = useState(Date.now);

  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: () => api.get<Me>('/auth/me') });
  const parcelsQ = useParcels();
  const parcels = useMemo(
    () => (parcelsQ.data ?? []).filter((p) => !p.archived),
    [parcelsQ.data],
  );
  const q = search.trim().toLocaleLowerCase();
  const filteredParcels = useMemo(() => parcels.filter((p) => {
    if (!q) return true;
    return p.name.toLocaleLowerCase().includes(q) || cropLabel(p.crop).toLocaleLowerCase().includes(q);
  }), [parcels, q]);
  const filteredParcelIds = useMemo(
    () => new Set(filteredParcels.map((p) => p.id)),
    [filteredParcels],
  );
  const ids = useMemo(() => parcels.map((p) => p.id), [parcels]);
  const latestQ = useLatestIndices(ids);
  const latest: LatestBatch = latestQ.data ?? {};
  const openAlertsQ = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: () => api.get<Alert[]>('/alerts?state=open'),
  });
  const openAlerts = openAlertsQ.data ?? [];

  // per-parcel NDVI spark series — same key as the parcel detail chart, so the whole app
  // shares one cache entry per parcel+index.
  const sparkResults = useQueries({
    queries: parcels.map((p) => ({
      queryKey: ['indices', p.id, 'ndvi'],
      queryFn: () => api.get<Spark>(`/parcels/${p.id}/indices?index=ndvi`),
      staleTime: 5 * 60 * 1000,
    })),
  });
  const sparkByParcel = useMemo(() => {
    const m: Record<string, IndexPoint[]> = {};
    parcels.forEach((p, i) => {
      m[p.id] = sparkResults[i]?.data?.series ?? [];
    });
    return m;
  }, [parcels, sparkResults]);

  const severityByParcel = worstSeverityByParcel(openAlerts);
  const parcelNames = useParcelNames();

  // Latest acquisition across the currently visible parcels → map-card date.
  let lastPass: string | null = null;
  for (const p of filteredParcels) {
    const li = latest[p.id];
    const at = li?.ndvi?.observed_at;
    if (at && (!lastPass || at > lastPass)) lastPass = at;
  }

  const totalHa = filteredParcels.reduce((s, p) => s + p.area_ha, 0);
  const org = me.data?.org?.name;
  const subtitle = [
    org,
    t('dashboard.parcel_count', { count: filteredParcels.length }),
    t('fields.hectares', { ha: totalHa.toFixed(1), defaultValue: '{{ha}} ha' }),
  ]
    .filter(Boolean)
    .join(' · ');

  const mapDateStr = lastPass
    ? format(parseISO(lastPass), 'd MMM yyyy', { locale: dfLocale() })
    : null;

  // The default map is score-first; scientific layers are an opt-in advanced view.
  const mapFeatures = useMemo<ParcelFeature[]>(() => {
    const lb = latestQ.data ?? {};
    return filteredParcels.map((p) => {
      if (!selectedIndex) {
        const score = arvoScore(lb[p.id])?.value ?? null;
        return { parcel: p, color: score == null ? NEUTRAL_FILL : scoreColor(score) };
      }
      const v = lb[p.id]?.[selectedIndex]?.mean ?? null;
      return { parcel: p, color: v == null ? NEUTRAL_FILL : indexColor(selectedIndex, v) };
    });
  }, [filteredParcels, latestQ.data, selectedIndex]);

  // legend gradient — score by default, raw domain only in advanced mode
  const [domainMin, domainMax] = selectedIndex ? INDEX_DOMAIN[selectedIndex] : [0, 100];
  const legendStops = Array.from({ length: 6 }, (_, i) => {
    const v = domainMin + ((domainMax - domainMin) * i) / 5;
    return selectedIndex ? indexColor(selectedIndex, v) : scoreColor(v);
  });

  // needs-attention: top open alerts (severity then recency); "N NEW" = created <24h
  const visibleOpenAlerts = openAlerts.filter(
    (a) => !a.parcel_id || filteredParcelIds.has(a.parcel_id),
  );
  const newCount = visibleOpenAlerts.filter(
    (a) => renderedAt - new Date(a.created_at).getTime() < DAY_MS,
  ).length;
  const topAlerts = sortBySeverityThenRecency(visibleOpenAlerts).slice(0, 4);

  // overall condition: average Arvo Score, trend, and alert-derived status distribution
  const parcelScores = filteredParcels
    .map((p) => arvoScore(latest[p.id])?.value)
    .filter((v): v is number => v != null);
  const avgScore = parcelScores.length
    ? parcelScores.reduce((a, b) => a + b, 0) / parcelScores.length
    : null;
  const passDeltas = filteredParcels
    .map((p) => lastPassDelta(sparkByParcel[p.id] ?? []))
    .filter((v): v is number => v != null);
  const avgDelta = passDeltas.length
    ? passDeltas.reduce((a, b) => a + b, 0) / passDeltas.length
    : null;
  const statusAgg: Record<Status, { count: number; area: number }> = {
    healthy: { count: 0, area: 0 },
    watch: { count: 0, area: 0 },
    attention: { count: 0, area: 0 },
  };
  for (const p of filteredParcels) {
    const s = statusForSeverity(severityByParcel[p.id]);
    statusAgg[s].count += 1;
    statusAgg[s].area += p.area_ha;
  }
  const totalCount = filteredParcels.length;

  // dominant status = the one with most parcels; ties resolve to the worse status.
  const worseRank: Record<Status, number> = { healthy: 0, watch: 1, attention: 2 };
  let dominantStatus: Status = 'healthy';
  for (const s of STATUS_ORDER) {
    const cnt = statusAgg[s].count;
    const best = statusAgg[dominantStatus].count;
    if (cnt > best || (cnt === best && cnt > 0 && worseRank[s] > worseRank[dominantStatus])) {
      dominantStatus = s;
    }
  }

  // parcels table: score-first; advanced users can opt into sorting by a raw index.
  const sorted = [...filteredParcels].sort((a, b) => {
    const va = selectedIndex
      ? latest[a.id]?.[selectedIndex]?.mean
      : arvoScore(latest[a.id])?.value;
    const vb = selectedIndex
      ? latest[b.id]?.[selectedIndex]?.mean
      : arvoScore(latest[b.id])?.value;
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return sortDir === 'desc' ? vb - va : va - vb;
  });

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
        <Text style={styles.errorText}>{t('dashboard.load_error')}</Text>
        <InteractivePressable style={styles.cta} onPress={() => parcelsQ.refetch()}>
          <Text style={styles.ctaText}>{t('common.retry')}</Text>
        </InteractivePressable>
      </View>
    );
  }

  const indexLabel = selectedIndex ? selectedIndex.toUpperCase() : t('score.name');

  return (
    <View style={styles.page}>
      {/* page header */}
      <View style={styles.pageHeader}>
        <View style={styles.flex1}>
          <Text style={styles.h1}>{t('dashboard.title')}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>
        <View style={styles.headerRight}>
          <View style={styles.search}>
            <Ionicons name="search" size={15} color={colors.textFaint} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder={t('fields.search_placeholder', { defaultValue: 'Search parcels' })}
              placeholderTextColor={colors.textFaint}
              style={styles.searchInput}
            />
          </View>
        </View>
      </View>

      {/* map + right rail */}
      <View style={styles.topRow}>
        <View style={styles.mapCard}>
          <View style={styles.mapHeader}>
            <View style={styles.mapViewControls}>
              <InteractivePressable
                onPress={() => setSelectedIndex(null)}
                style={[styles.indexTab, selectedIndex == null ? styles.indexTabActive : styles.indexTabIdle]}
                hoverStyle={selectedIndex != null ? styles.controlHover : undefined}
              >
                <Text style={[styles.indexTabText, selectedIndex == null ? styles.indexTabTextActive : styles.indexTabTextIdle]}>
                  {t('score.name')}
                </Text>
              </InteractivePressable>
              <InteractivePressable
                onPress={() => setShowAdvanced((v) => !v)}
                style={styles.advancedToggle}
                hoverStyle={styles.softHover}
              >
                <Ionicons name={showAdvanced ? 'chevron-up' : 'options-outline'} size={13} color={colors.textMuted} />
                <Text style={styles.advancedToggleText}>
                  {t(showAdvanced ? 'indices.hide_advanced' : 'indices.advanced')}
                </Text>
              </InteractivePressable>
              {showAdvanced ? INDEX_NAMES.map((idx) => {
                const active = idx === selectedIndex;
                return (
                  <InteractivePressable key={idx} onPress={() => setSelectedIndex(idx)} style={[styles.indexTab, active ? styles.indexTabActive : styles.indexTabIdle]} hoverStyle={!active ? styles.controlHover : undefined}>
                    <Text style={[styles.indexTabText, active ? styles.indexTabTextActive : styles.indexTabTextIdle]}>
                      {t(`index.${idx}.name`)} · {idx.toUpperCase()}
                    </Text>
                  </InteractivePressable>
                );
              }) : null}
            </View>
            <View style={styles.mapHeaderActions}>
              {mapDateStr ? (
                <MonoLabel size={11} color={colors.textMuted}>
                  {mapDateStr}
                </MonoLabel>
              ) : null}
              <InteractivePressable
                accessibilityLabel={t('fields.maximize_map')}
                onPress={() => router.push('/map')}
                style={styles.maximizeMapButton}
                hoverStyle={styles.softHover}
                focusStyle={styles.maximizeMapFocus}
              >
                <Ionicons name="expand-outline" size={16} color={colors.primary} />
              </InteractivePressable>
            </View>
          </View>
          <View style={styles.mapWrap}>
            {filteredParcels.length === 0 ? (
              <View style={styles.mapEmpty}>
                <Ionicons name="search" size={20} color={colors.textFaint} />
                <Text style={styles.muted}>
                  {t('fields.no_matches', { defaultValue: 'No matching parcels' })}
                </Text>
              </View>
            ) : (
              <>
                <MapView
                  parcels={mapFeatures}
                  mode="view"
                  onSelectParcel={(id) => router.push(`/parcel/${id}`)}
                />
                <View style={styles.legend} pointerEvents="none">
                  <MonoLabel size={9}>{selectedIndex ? `${t(`index.${selectedIndex}.name`)} · ${indexLabel}` : t('map.score_legend')}</MonoLabel>
                  <View style={styles.legendBar}>
                    {legendStops.map((c, i) => (
                      <View
                        key={i}
                        style={[
                          styles.legendStop,
                          { backgroundColor: c },
                          i === 0 && styles.legendStopL,
                          i === legendStops.length - 1 && styles.legendStopR,
                        ]}
                      />
                    ))}
                  </View>
                  <View style={styles.legendRange}>
                    <MonoLabel size={9}>{selectedIndex ? domainMin.toFixed(1) : t('map.score_low')}</MonoLabel>
                    <MonoLabel size={9}>{selectedIndex ? domainMax.toFixed(1) : t('map.score_high')}</MonoLabel>
                  </View>
                </View>
              </>
            )}
          </View>
        </View>

        <View style={styles.rail}>
          {/* needs attention */}
          <Card style={styles.railCard}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardTitle}>
                {t('fields.needs_attention', { defaultValue: 'Needs attention' })}
              </Text>
              {newCount > 0 ? (
                <Pill
                  label={t('fields.new_count', { count: newCount, defaultValue: '{{count}} NEW' })}
                  fg={colors.accent}
                  bg={statusColors.attention.bg}
                />
              ) : null}
            </View>
            {topAlerts.length === 0 ? (
              <Text style={styles.muted}>
                {filteredParcels.length === 0
                  ? t('fields.no_matches', { defaultValue: 'No matching parcels' })
                  : t('fields.all_clear', { defaultValue: 'All clear' })}
              </Text>
            ) : (
              <View style={styles.attnList}>
                {topAlerts.map((a) => {
                  const tint = severityTint[a.severity];
                  const where = a.parcel_id
                    ? (parcelNames[a.parcel_id] ??
                      t('fields.all_parcels', { defaultValue: 'All parcels' }))
                    : t('fields.all_parcels', { defaultValue: 'All parcels' });
                  const ago = formatDistanceToNow(parseISO(a.created_at), { locale: dfLocale() });
                  return (
                    <InteractivePressable
                      key={a.id}
                      onPress={() => router.push('/alerts')}
                      style={styles.attnRow}
                      hoverStyle={styles.attnRowHover}
                    >
                      <GlyphBadge glyph={kindGlyph(a.kind)} fg={tint.fg} bg={tint.bg} size={26} />
                      <View style={styles.flex1}>
                        <Text style={styles.attnTitle} numberOfLines={1}>
                          {a.title}
                        </Text>
                        <Text style={styles.attnMeta} numberOfLines={1}>
                          {`${where} · ${ago}`}
                        </Text>
                      </View>
                    </InteractivePressable>
                  );
                })}
              </View>
            )}
            <InteractivePressable onPress={() => router.push('/alerts')} style={styles.inlineLink} hoverStyle={styles.linkHover}>
              <Text style={styles.link}>
                {`${t('fields.open_insights', { defaultValue: 'Open insights' })} →`}
              </Text>
            </InteractivePressable>
          </Card>

          {/* field health */}
          <GlyphCard
            gradient={statusGradient(dominantStatus)}
            glyph="sprout"
            glyphColor={statusColors[dominantStatus].fg}
            glyphSize={110}
            style={[styles.railCard, styles.healthCard]}
          >
            <Text style={styles.cardTitle}>
              {t('fields.field_health', { defaultValue: 'Field health' })}
            </Text>
            <View style={styles.healthTop}>
              {/* The numeral tracks the score band, like the surface gradient behind it. */}
              <MonoValue size={40} weight="500" color={avgScore == null ? colors.textFaint : scoreColor(avgScore)}>
                {avgScore == null ? '—' : Math.round(avgScore)}
              </MonoValue>
              <View style={styles.healthMeta}>
                <MonoLabel>{t('fields.avg_ndvi', { defaultValue: 'Avg NDVI' })}</MonoLabel>
                <Text style={styles.scoreCaption}>{t('score.short_explanation')}</Text>
                <View style={styles.healthDeltaRow}>
                  <Ionicons
                    name={trendBand(avgDelta) === 'improving' ? 'trending-up' : trendBand(avgDelta) === 'declining' ? 'trending-down' : 'remove'}
                    size={15}
                    color={trendBand(avgDelta) === 'declining' ? colors.accent : colors.primary}
                  />
                  <Text style={styles.mutedSmall}>
                    {t(`trend.${trendBand(avgDelta)}`)} · {t('fields.vs_last_pass', { defaultValue: 'vs last pass' })}
                  </Text>
                </View>
              </View>
            </View>
            <View style={styles.stack}>
              {STATUS_ORDER.map((s) => {
                const frac = totalCount ? statusAgg[s].count / totalCount : 0;
                if (frac === 0) return null;
                return (
                  <View
                    key={s}
                    style={{ width: `${frac * 100}%`, backgroundColor: statusColors[s].fg }}
                  />
                );
              })}
            </View>
            <View style={styles.healthLegend}>
              {STATUS_ORDER.map((s) => (
                <View key={s} style={styles.healthLegendRow}>
                  <StatusChip status={s} label={t(`status.${s}`)} />
                  <MonoValue size={12} weight="500" color={colors.textMuted} style={styles.healthLegendVal}>
                    {`${statusAgg[s].count} · ${statusAgg[s].area.toFixed(1)} ha`}
                  </MonoValue>
                </View>
              ))}
            </View>
          </GlyphCard>
        </View>
      </View>

      {/* parcels table */}
      <View style={styles.tableCard}>
        <View style={styles.tableHeader}>
          <Text style={styles.cardTitle}>{t('fields.parcels', { defaultValue: 'Parcels' })}</Text>
          <InteractivePressable onPress={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))} style={styles.sortButton} hoverStyle={styles.softHover}>
            <MonoLabel size={11}>
              {`${selectedIndex ? t('fields.sorted_by', { index: indexLabel }) : t('fields.sorted_by_score')} ${
                sortDir === 'desc' ? '▾' : '▴'
              }`}
            </MonoLabel>
          </InteractivePressable>
        </View>

        <View style={styles.colHead}>
          <MonoLabel style={styles.cParcel}>
            {t('fields.col_parcel', { defaultValue: 'Parcel' })}
          </MonoLabel>
          <MonoLabel style={styles.cCrop}>{t('parcel.crop')}</MonoLabel>
          <MonoLabel style={styles.cArea}>{t('fields.col_area', { defaultValue: 'Area' })}</MonoLabel>
          <MonoLabel style={styles.cIndex}>{selectedIndex ? `${t(`index.${selectedIndex}.name`)} · ${indexLabel}` : t('score.name')}</MonoLabel>
          <MonoLabel style={styles.cTrend}>
            {t('fields.col_7day', { defaultValue: '7-day' })}
          </MonoLabel>
          <MonoLabel style={styles.cStatus}>
            {t('fields.col_status', { defaultValue: 'Status' })}
          </MonoLabel>
        </View>

        {sorted.length === 0 ? (
          <View style={styles.tableEmpty}>
            <Text style={styles.muted}>
              {search
                ? t('fields.no_matches', { defaultValue: 'No matching parcels' })
                : t('dashboard.empty_title')}
            </Text>
          </View>
        ) : (
          sorted.map((p) => {
            const status = statusForSeverity(severityByParcel[p.id]);
            const score = arvoScore(latest[p.id]);
            const iv = selectedIndex ? latest[p.id]?.[selectedIndex]?.mean ?? null : score?.value ?? null;
            const seven = sevenDayDelta(sparkByParcel[p.id] ?? []);
            const ratio =
              iv == null ? 0 : Math.max(0, Math.min(1, (iv - domainMin) / (domainMax - domainMin)));
            return (
              <InteractivePressable
                key={p.id}
                onPress={() => router.push(`/parcel/${p.id}`)}
                style={styles.row}
                hoverStyle={styles.rowHover}
              >
                <View style={[styles.cParcel, styles.parcelCell]}>
                  <Text style={styles.parcelName} numberOfLines={1}>
                    {p.name}
                  </Text>
                </View>
                <Text style={[styles.cCrop, styles.cropText]} numberOfLines={1}>
                  {cropLabel(p.crop)}
                </Text>
                <Text style={[styles.cArea, styles.areaText]}>{`${p.area_ha.toFixed(1)} ha`}</Text>
                <View style={[styles.cIndex, styles.indexCell]}>
                  <View>
                    <Text style={styles.indexVal}>{iv == null ? '—' : selectedIndex ? iv.toFixed(2) : Math.round(iv)}</Text>
                    {!selectedIndex && score ? (
                      <Text style={styles.indexMeaning}>{t(`score.band.${scoreBand(score.value)}`)}</Text>
                    ) : null}
                  </View>
                  <View style={styles.trackOuter}>
                    <View
                      style={[
                        styles.trackInner,
                        {
                          width: `${ratio * 100}%`,
                          backgroundColor: iv == null ? colors.borderSoft : selectedIndex ? indexColor(selectedIndex, iv) : scoreColor(iv),
                        },
                      ]}
                    />
                  </View>
                </View>
                <View style={[styles.cTrend, styles.trendCell]}>
                  <Ionicons
                    name={trendBand(seven) === 'improving' ? 'trending-up' : trendBand(seven) === 'declining' ? 'trending-down' : 'remove'}
                    size={15}
                    color={trendBand(seven) === 'declining' ? colors.accent : colors.primary}
                  />
                  <Text style={styles.trendText}>{t(`trend.${trendBand(seven)}`)}</Text>
                </View>
                <View style={styles.cStatus}>
                  <StatusChip status={status} label={t(`status.${status}`)} />
                </View>
              </InteractivePressable>
            );
          })
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { gap: spacing.md },
  flex1: { flex: 1, minWidth: 0 },
  center: {
    flex: 1,
    minHeight: 320,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    backgroundColor: colors.bg,
  },
  errorText: { color: colors.danger, fontSize: 14 },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  ctaText: { fontFamily: fonts.bodyBold, color: colors.onPrimary, fontSize: 15 },

  // header
  pageHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  h1: { fontFamily: fonts.display, fontSize: 28, color: colors.text },
  subtitle: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, marginTop: 3 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 36,
    minWidth: 210,
    paddingHorizontal: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  searchInput: { flex: 1, fontFamily: fonts.body, fontSize: 13, color: colors.text },
  // top row
  topRow: { flexDirection: 'row', gap: spacing.lg, alignItems: 'stretch' },

  // map card
  mapCard: {
    flex: 1.62,
    minWidth: 0,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  mapHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  mapHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  maximizeMapButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  maximizeMapFocus: { borderColor: colors.focus },
  mapViewControls: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  indexTab: { paddingHorizontal: 11, paddingVertical: 5, borderRadius: radius.sm },
  indexTabActive: { backgroundColor: colors.primary },
  indexTabIdle: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  indexTabText: { fontFamily: fonts.monoSemiBold, fontSize: 11.5, letterSpacing: 0.4 },
  indexTabTextActive: { color: colors.onPrimary },
  indexTabTextIdle: { color: colors.textMuted },
  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  advancedToggleText: { fontFamily: fonts.bodySemiBold, fontSize: 11.5, color: colors.textMuted },
  mapWrap: { position: 'relative', flex: 1, minHeight: MAP_HEIGHT },
  mapEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  legend: {
    position: 'absolute',
    left: spacing.sm,
    bottom: spacing.sm,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  legendBar: { flexDirection: 'row', marginTop: 5, marginBottom: 4 },
  legendStop: { width: 16, height: 8 },
  legendStopL: { borderTopLeftRadius: 3, borderBottomLeftRadius: 3 },
  legendStopR: { borderTopRightRadius: 3, borderBottomRightRadius: 3 },
  legendRange: { flexDirection: 'row', justifyContent: 'space-between' },

  // right rail
  rail: { flex: 1, minWidth: 300, gap: spacing.md },
  railCard: { padding: spacing.md },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  cardTitle: { fontFamily: fonts.display, fontSize: 17, color: colors.text },
  attnList: { gap: spacing.md, marginBottom: spacing.md },
  attnRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  attnRowHover: { backgroundColor: colors.cardAlt, borderRadius: radius.sm },
  attnTitle: { fontFamily: fonts.bodyBold, fontSize: 13, color: colors.text },
  attnMeta: { fontFamily: fonts.mono, fontSize: 10.5, color: colors.textFaint, marginTop: 3 },
  muted: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, marginBottom: spacing.md },
  link: { fontFamily: fonts.bodyBold, fontSize: 12.5, color: colors.primary },
  inlineLink: { alignSelf: 'flex-start', borderRadius: radius.sm, padding: 3, marginLeft: -3 },
  linkHover: { backgroundColor: colors.primarySoft },

  // field health
  healthCard: { flex: 1, borderRadius: radius.lg },
  healthTop: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  healthMeta: { paddingBottom: 4, gap: 3 },
  scoreCaption: { maxWidth: 190, fontFamily: fonts.body, fontSize: 11, lineHeight: 15, color: colors.textMuted },
  healthDeltaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  mutedSmall: { fontFamily: fonts.body, fontSize: 11, color: colors.textFaint },
  stack: {
    flexDirection: 'row',
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: colors.borderSoft,
    marginBottom: spacing.md,
  },
  healthLegend: { gap: spacing.sm },
  healthLegendRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  healthLegendVal: { marginLeft: 'auto' },

  // table
  tableCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  sortButton: { padding: 5, borderRadius: radius.sm },
  colHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  cParcel: { flex: 2, minWidth: 0 },
  cCrop: { flex: 1.3, minWidth: 0 },
  cArea: { flex: 0.9, minWidth: 0 },
  cIndex: { flex: 1.6, minWidth: 0 },
  cTrend: { flex: 1, minWidth: 0 },
  cStatus: { flex: 1.1, minWidth: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  rowHover: { backgroundColor: colors.cardAlt },
  softHover: { backgroundColor: colors.cardAlt, borderRadius: radius.sm },
  controlHover: { backgroundColor: colors.cardAlt, borderColor: colors.primary },
  parcelCell: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  parcelName: { flex: 1, fontFamily: fonts.display, fontSize: 15, color: colors.text },
  cropText: { fontFamily: fonts.body, fontSize: 12.5, color: colors.textMuted },
  areaText: { fontFamily: fonts.mono, fontSize: 12, color: colors.textMuted },
  indexCell: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  indexVal: { fontFamily: fonts.monoSemiBold, fontSize: 13, color: colors.text, minWidth: 36 },
  indexMeaning: { fontFamily: fonts.body, fontSize: 10.5, color: colors.textMuted, marginTop: 1 },
  trackOuter: {
    width: 64,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.borderSoft,
    overflow: 'hidden',
  },
  trackInner: { height: 6, borderRadius: 3 },
  trendCell: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  trendText: { fontFamily: fonts.bodyMedium, fontSize: 11.5, color: colors.textMuted },
  tableEmpty: { padding: spacing.lg, alignItems: 'center' },
});

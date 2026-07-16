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
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { api } from '@/api/client';
import { INDEX_NAMES } from '@/api/types';
import type { Alert, IndexName, IndexPoint, LatestIndices, Org, Parcel, Role, User } from '@/api/types';
import MapView from '@/components/MapView';
import type { ParcelFeature } from '@/components/types';
import { Card, Delta, Dot, MonoLabel, MonoValue, Pill, StatusChip } from '@/components/ui';
import { INDEX_DOMAIN, cropLabel, dfLocale, indexColor } from '@/features/insights/format';
import { NEUTRAL_FILL } from '@/features/parcels/crops';
import { useLatestIndices, useParcels } from '@/features/parcels/hooks';
import {
  colors,
  fonts,
  radius,
  severityColor,
  spacing,
  statusColors,
  statusForSeverity,
  type Status,
} from '@/theme';

type Me = { user: User; org: Org; role: Role };
type LatestBatch = Record<string, LatestIndices>;
type Spark = { index: IndexName; series: IndexPoint[] };

const DAY_MS = 86_400_000;
const MAP_HEIGHT = 380;
const STATUS_ORDER: Status[] = ['healthy', 'watch', 'attention'];
// react-native-web adds `hovered` to the Pressable interaction state (not in the RN types).
type HoverState = { hovered?: boolean };

/** Worst open severity per parcel ('critical' > 'warning' > 'info'). */
function worstSeverity(alerts: Alert[]): Record<string, string> {
  const rank: Record<string, number> = { info: 1, warning: 2, critical: 3 };
  const out: Record<string, string> = {};
  for (const a of alerts) {
    if (!a.parcel_id) continue;
    if ((rank[a.severity] ?? 0) > (rank[out[a.parcel_id]] ?? 0)) out[a.parcel_id] = a.severity;
  }
  return out;
}

/** 7-day change: latest mean minus the closest observation ≥6.5 days earlier. */
function sevenDayDelta(series: IndexPoint[]): number | null {
  if (series.length < 2) return null;
  const last = series[series.length - 1];
  const lastT = parseISO(last.observed_at).getTime();
  const ref = [...series]
    .reverse()
    .find((p) => lastT - parseISO(p.observed_at).getTime() >= 6.5 * DAY_MS);
  return ref ? last.mean - ref.mean : null;
}

/** Change vs the immediately previous pass (last two points of the series). */
function lastPassDelta(series: IndexPoint[]): number | null {
  if (series.length < 2) return null;
  return series[series.length - 1].mean - series[series.length - 2].mean;
}

function initials(name?: string | null): string {
  if (!name) return '—';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  const a = parts[0][0] ?? '';
  const b = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (a + b).toUpperCase() || '—';
}

export default function FieldsWeb() {
  const { t } = useTranslation();
  const router = useRouter();

  const [selectedIndex, setSelectedIndex] = useState<IndexName>('ndvi');
  const [search, setSearch] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: () => api.get<Me>('/auth/me') });
  const parcelsQ = useParcels();
  const parcels = useMemo(
    () => (parcelsQ.data ?? []).filter((p) => !p.archived),
    [parcelsQ.data],
  );
  const ids = useMemo(() => parcels.map((p) => p.id), [parcels]);
  const latestQ = useLatestIndices(ids);
  const latest: LatestBatch = latestQ.data ?? {};
  const openAlertsQ = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: () => api.get<Alert[]>('/alerts?state=open'),
  });
  const openAlerts = openAlertsQ.data ?? [];

  // per-parcel NDVI spark series — same key as the native rows, so the cache is shared.
  const sparkResults = useQueries({
    queries: parcels.map((p) => ({
      queryKey: ['indices', p.id, 'ndvi', 'spark'],
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

  const severityByParcel = worstSeverity(openAlerts);
  const parcelNames: Record<string, string> = {};
  for (const p of parcels) parcelNames[p.id] = p.name;

  // latest acquisition across parcels → header + map-card date chips
  let lastPass: string | null = null;
  for (const li of Object.values(latest)) {
    const at = li.ndvi?.observed_at;
    if (at && (!lastPass || at > lastPass)) lastPass = at;
  }

  const totalHa = parcels.reduce((s, p) => s + p.area_ha, 0);
  const org = me.data?.org?.name;
  const subtitle = [
    org,
    t('dashboard.parcel_count', { count: parcels.length }),
    t('fields.hectares', { ha: totalHa.toFixed(1), defaultValue: '{{ha}} ha' }),
  ]
    .filter(Boolean)
    .join(' · ');

  const dateStr = lastPass ? format(parseISO(lastPass), 'd MMM', { locale: dfLocale() }) : null;
  const mapDateStr = lastPass
    ? format(parseISO(lastPass), 'd MMM yyyy', { locale: dfLocale() })
    : null;

  // map fills colored by the selected index (NEUTRAL_FILL when a parcel has no reading yet)
  const mapFeatures = useMemo<ParcelFeature[]>(() => {
    const lb = latestQ.data ?? {};
    return parcels.map((p) => {
      const v = lb[p.id]?.[selectedIndex]?.mean ?? null;
      return { parcel: p, color: v == null ? NEUTRAL_FILL : indexColor(selectedIndex, v) };
    });
  }, [parcels, latestQ.data, selectedIndex]);

  // legend gradient — 6 sampled stops across the selected index domain
  const [domainMin, domainMax] = INDEX_DOMAIN[selectedIndex];
  const legendStops = Array.from({ length: 6 }, (_, i) =>
    indexColor(selectedIndex, domainMin + ((domainMax - domainMin) * i) / 5),
  );

  // needs-attention: top open alerts (severity then recency); "N NEW" = created <24h
  const newCount = openAlerts.filter(
    (a) => Date.now() - new Date(a.created_at).getTime() < DAY_MS,
  ).length;
  const topAlerts = [...openAlerts]
    .sort((a, b) => {
      const rank: Record<string, number> = { info: 1, warning: 2, critical: 3 };
      return (
        (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0) ||
        b.created_at.localeCompare(a.created_at)
      );
    })
    .slice(0, 4);

  // field health: avg NDVI, avg last-pass delta, status distribution by count/area
  const ndviMeans = parcels
    .map((p) => latest[p.id]?.ndvi?.mean)
    .filter((v): v is number => v != null);
  const avgNdvi = ndviMeans.length
    ? ndviMeans.reduce((a, b) => a + b, 0) / ndviMeans.length
    : null;
  const passDeltas = parcels
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
  for (const p of parcels) {
    const s = statusForSeverity(severityByParcel[p.id]);
    statusAgg[s].count += 1;
    statusAgg[s].area += p.area_ha;
  }
  const totalCount = parcels.length;

  // parcels table: filter by search, sort by the selected index value (nulls last)
  const q = search.trim().toLowerCase();
  const filtered = parcels.filter((p) => {
    if (!q) return true;
    return p.name.toLowerCase().includes(q) || cropLabel(p.crop).toLowerCase().includes(q);
  });
  const sorted = [...filtered].sort((a, b) => {
    const va = latest[a.id]?.[selectedIndex]?.mean;
    const vb = latest[b.id]?.[selectedIndex]?.mean;
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
        <Pressable style={styles.cta} onPress={() => parcelsQ.refetch()}>
          <Text style={styles.ctaText}>{t('common.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  const indexLabel = selectedIndex.toUpperCase();

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
          {dateStr ? (
            <View style={styles.passChip}>
              <Dot color={colors.success} size={6} />
              <MonoLabel size={11} color={colors.primaryDark}>
                {`${t('fields.latest_pass', { defaultValue: 'Latest pass' })} · ${dateStr}`}
              </MonoLabel>
            </View>
          ) : null}
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(me.data?.user.full_name)}</Text>
          </View>
        </View>
      </View>

      {/* map + right rail */}
      <View style={styles.topRow}>
        <View style={styles.mapCard}>
          <View style={styles.mapHeader}>
            <View style={styles.indexTabs}>
              {INDEX_NAMES.map((idx) => {
                const active = idx === selectedIndex;
                return (
                  <Pressable
                    key={idx}
                    onPress={() => setSelectedIndex(idx)}
                    style={[styles.indexTab, active ? styles.indexTabActive : styles.indexTabIdle]}
                  >
                    <Text
                      style={[
                        styles.indexTabText,
                        active ? styles.indexTabTextActive : styles.indexTabTextIdle,
                      ]}
                    >
                      {idx.toUpperCase()}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {mapDateStr ? (
              <MonoLabel size={11} color={colors.textMuted}>
                {mapDateStr}
              </MonoLabel>
            ) : null}
          </View>
          <View style={styles.mapWrap}>
            <MapView
              parcels={mapFeatures}
              mode="view"
              height={MAP_HEIGHT}
              onSelectParcel={(id) => router.push(`/parcel/${id}`)}
            />
            <View style={styles.legend} pointerEvents="none">
              <MonoLabel size={9}>{indexLabel}</MonoLabel>
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
                <MonoLabel size={9}>{domainMin.toFixed(1)}</MonoLabel>
                <MonoLabel size={9}>{domainMax.toFixed(1)}</MonoLabel>
              </View>
            </View>
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
              <Text style={styles.muted}>{t('fields.all_clear', { defaultValue: 'All clear' })}</Text>
            ) : (
              <View style={styles.attnList}>
                {topAlerts.map((a) => {
                  const c = severityColor[a.severity] ?? colors.info;
                  const where = a.parcel_id
                    ? (parcelNames[a.parcel_id] ??
                      t('fields.all_parcels', { defaultValue: 'All parcels' }))
                    : t('fields.all_parcels', { defaultValue: 'All parcels' });
                  const ago = formatDistanceToNow(parseISO(a.created_at), { locale: dfLocale() });
                  return (
                    <Pressable
                      key={a.id}
                      onPress={() => router.push('/alerts')}
                      style={styles.attnRow}
                    >
                      <View style={styles.attnDotWrap}>
                        <Dot color={c} size={9} />
                      </View>
                      <View style={styles.flex1}>
                        <Text style={styles.attnTitle} numberOfLines={1}>
                          {a.title}
                        </Text>
                        <Text style={styles.attnMeta} numberOfLines={1}>
                          {`${where} · ${ago}`}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}
            <Pressable onPress={() => router.push('/alerts')}>
              <Text style={styles.link}>
                {`${t('fields.open_insights', { defaultValue: 'Open insights' })} →`}
              </Text>
            </Pressable>
          </Card>

          {/* field health */}
          <Card style={[styles.railCard, styles.healthCard]}>
            <Text style={styles.cardTitle}>
              {t('fields.field_health', { defaultValue: 'Field health' })}
            </Text>
            <View style={styles.healthTop}>
              <MonoValue size={40} weight="500" color={colors.success}>
                {avgNdvi == null ? '—' : avgNdvi.toFixed(2)}
              </MonoValue>
              <View style={styles.healthMeta}>
                <MonoLabel>{t('fields.avg_ndvi', { defaultValue: 'Avg NDVI' })}</MonoLabel>
                <View style={styles.healthDeltaRow}>
                  <Delta value={avgDelta} />
                  <Text style={styles.mutedSmall}>
                    {t('fields.vs_last_pass', { defaultValue: 'vs last pass' })}
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
                  <Dot color={statusColors[s].fg} size={8} />
                  <Text style={styles.healthLegendLabel}>{t(`status.${s}`)}</Text>
                  <Text style={styles.healthLegendVal}>
                    {`${statusAgg[s].count} · ${statusAgg[s].area.toFixed(1)} ha`}
                  </Text>
                </View>
              ))}
            </View>
          </Card>
        </View>
      </View>

      {/* parcels table */}
      <View style={styles.tableCard}>
        <View style={styles.tableHeader}>
          <Text style={styles.cardTitle}>{t('fields.parcels', { defaultValue: 'Parcels' })}</Text>
          <Pressable onPress={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}>
            <MonoLabel size={11}>
              {`${t('fields.sorted_by', { index: indexLabel, defaultValue: 'Sorted by {{index}}' })} ${
                sortDir === 'desc' ? '▾' : '▴'
              }`}
            </MonoLabel>
          </Pressable>
        </View>

        <View style={styles.colHead}>
          <MonoLabel style={styles.cParcel}>
            {t('fields.col_parcel', { defaultValue: 'Parcel' })}
          </MonoLabel>
          <MonoLabel style={styles.cCrop}>{t('parcel.crop')}</MonoLabel>
          <MonoLabel style={styles.cArea}>{t('fields.col_area', { defaultValue: 'Area' })}</MonoLabel>
          <MonoLabel style={styles.cIndex}>{indexLabel}</MonoLabel>
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
            const iv = latest[p.id]?.[selectedIndex]?.mean ?? null;
            const seven = sevenDayDelta(sparkByParcel[p.id] ?? []);
            const ratio =
              iv == null ? 0 : Math.max(0, Math.min(1, (iv - domainMin) / (domainMax - domainMin)));
            return (
              <Pressable
                key={p.id}
                onPress={() => router.push(`/parcel/${p.id}`)}
                style={(state) => [styles.row, (state as HoverState).hovered && styles.rowHover]}
              >
                <View style={[styles.cParcel, styles.parcelCell]}>
                  <Dot color={statusColors[status].fg} size={10} />
                  <Text style={styles.parcelName} numberOfLines={1}>
                    {p.name}
                  </Text>
                </View>
                <Text style={[styles.cCrop, styles.cropText]} numberOfLines={1}>
                  {cropLabel(p.crop)}
                </Text>
                <Text style={[styles.cArea, styles.areaText]}>{`${p.area_ha.toFixed(1)} ha`}</Text>
                <View style={[styles.cIndex, styles.indexCell]}>
                  <Text style={styles.indexVal}>{iv == null ? '—' : iv.toFixed(2)}</Text>
                  <View style={styles.trackOuter}>
                    <View
                      style={[
                        styles.trackInner,
                        {
                          width: `${ratio * 100}%`,
                          backgroundColor: iv == null ? colors.borderSoft : indexColor(selectedIndex, iv),
                        },
                      ]}
                    />
                  </View>
                </View>
                <View style={styles.cTrend}>
                  <Delta value={seven} />
                </View>
                <View style={styles.cStatus}>
                  <StatusChip status={status} label={t(`status.${status}`)} />
                </View>
              </Pressable>
            );
          })
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.md, backgroundColor: colors.bg },
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
  ctaText: { color: colors.onPrimary, fontSize: 15, fontWeight: '700' },

  // header
  pageHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  h1: { fontSize: 26, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
  subtitle: { fontSize: 13, color: colors.textMuted, marginTop: 3 },
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
  searchInput: { flex: 1, fontSize: 13, color: colors.text },
  passChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 34,
    paddingHorizontal: 12,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 12.5, fontWeight: '700', color: colors.primaryDark },

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
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  indexTabs: { flexDirection: 'row', gap: spacing.xs },
  indexTab: { paddingHorizontal: 11, paddingVertical: 5, borderRadius: radius.sm },
  indexTabActive: { backgroundColor: colors.primary },
  indexTabIdle: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  indexTabText: { fontFamily: fonts.mono, fontSize: 11.5, fontWeight: '600', letterSpacing: 0.4 },
  indexTabTextActive: { color: colors.onPrimary },
  indexTabTextIdle: { color: colors.textMuted },
  mapWrap: { position: 'relative', height: MAP_HEIGHT },
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
  cardTitle: { fontSize: 14, fontWeight: '700', color: colors.text },
  attnList: { gap: spacing.md, marginBottom: spacing.md },
  attnRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  attnDotWrap: { marginTop: 4 },
  attnTitle: { fontSize: 13, fontWeight: '700', color: colors.text },
  attnMeta: { fontFamily: fonts.mono, fontSize: 10.5, color: colors.textFaint, marginTop: 3 },
  muted: { fontSize: 13, color: colors.textMuted, marginBottom: spacing.md },
  link: { fontSize: 12.5, fontWeight: '700', color: colors.primary },

  // field health
  healthCard: { flex: 1 },
  healthTop: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  healthMeta: { paddingBottom: 4, gap: 3 },
  healthDeltaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  mutedSmall: { fontSize: 11, color: colors.textFaint },
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
  healthLegendLabel: { fontSize: 12.5, color: colors.text },
  healthLegendVal: {
    marginLeft: 'auto',
    fontFamily: fonts.mono,
    fontSize: 11.5,
    color: colors.textMuted,
  },

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
  parcelCell: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  parcelName: { flex: 1, fontSize: 13.5, fontWeight: '700', color: colors.text },
  cropText: { fontSize: 12.5, color: colors.textMuted },
  areaText: { fontFamily: fonts.mono, fontSize: 12, color: colors.textMuted },
  indexCell: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  indexVal: { fontFamily: fonts.mono, fontSize: 13, fontWeight: '600', color: colors.text, minWidth: 36 },
  trackOuter: {
    width: 64,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.borderSoft,
    overflow: 'hidden',
  },
  trackInner: { height: 6, borderRadius: 3 },
  tableEmpty: { padding: spacing.lg, alignItems: 'center' },
});

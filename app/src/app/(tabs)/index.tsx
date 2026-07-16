// OWNER: fe-dashboard — Fields home (Campo): header + latest-pass meta, top attention banner,
// parcel rows with NDVI swatch, status chip (worst open alert), and 7-day delta.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api } from '@/api/client';
import type { Alert, IndexName, IndexPoint, LatestIndices, Org, Parcel, Role, User } from '@/api/types';
import { kindGlyph } from '@/components/glyphs';
import { GlyphBadge, MonoLabel, StatusChip, TintCard } from '@/components/ui';
import { arvoScore, cropLabel, dfLocale, scoreColor, trendBand } from '@/features/insights/format';
import {
  colors,
  fonts,
  radius,
  severityGradient,
  severityTint,
  spacing,
  statusForSeverity,
  type Status,
} from '@/theme';

type Me = { user: User; org: Org; role: Role };
type LatestBatch = Record<string, LatestIndices>;

const DAY_MS = 86_400_000;

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

export default function Dashboard() {
  const { t } = useTranslation();
  const router = useRouter();
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);

  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: () => api.get<Me>('/auth/me') });
  const parcels = useQuery({ queryKey: ['parcels'], queryFn: () => api.get<Parcel[]>('/parcels') });

  const ids = (parcels.data ?? []).map((p) => p.id);
  const latest = useQuery({
    queryKey: ['indices', 'latest', ids],
    queryFn: () => api.get<LatestBatch>(`/indices/latest?parcel_ids=${ids.join(',')}`),
    enabled: ids.length > 0,
  });
  const openAlerts = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: () => api.get<Alert[]>('/alerts?state=open'),
  });

  const severityByParcel = worstSeverity(openAlerts.data ?? []);
  const parcelNames: Record<string, string> = {};
  for (const p of parcels.data ?? []) parcelNames[p.id] = p.name;

  // banner = worst open alert (critical first, then warning), newest wins ties
  const banner = (openAlerts.data ?? [])
    .filter((a) => a.severity !== 'info')
    .sort((a, b) => {
      const rank: Record<string, number> = { warning: 1, critical: 2 };
      return (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0) || b.created_at.localeCompare(a.created_at);
    })[0];

  // latest acquisition across parcels → "14 JUL PASS"
  let lastPass: string | null = null;
  for (const li of Object.values(latest.data ?? {})) {
    const at = li.ndvi?.observed_at;
    if (at && (!lastPass || at > lastPass)) lastPass = at;
  }

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await qc.invalidateQueries();
    setRefreshing(false);
  }, [qc]);

  const list = parcels.data ?? [];
  const metaParts = [t('dashboard.parcel_count', { count: list.length })];
  if (lastPass) {
    metaParts.push(
      t('dashboard.last_pass', { date: format(parseISO(lastPass), 'd MMM', { locale: dfLocale() }) }),
    );
  }

  const header = (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <View style={styles.flex1}>
          <Text style={styles.title}>{t('dashboard.title')}</Text>
          <Text style={styles.org}>{me.data?.org.name ?? '—'}</Text>
        </View>
        <Pressable
          onPress={() => router.push('/alerts')}
          style={styles.bell}
          accessibilityLabel={t('tabs.alerts')}
        >
          <Ionicons name="notifications-outline" size={20} color={colors.text} />
          {(openAlerts.data?.length ?? 0) > 0 ? (
            <View style={styles.bellBadge}>
              <Text style={styles.bellBadgeText}>
                {(openAlerts.data?.length ?? 0) > 99 ? '99+' : (openAlerts.data?.length ?? 0)}
              </Text>
            </View>
          ) : null}
        </Pressable>
      </View>

      {banner ? (
        <BannerCard
          alert={banner}
          parcelName={banner.parcel_id ? parcelNames[banner.parcel_id] : undefined}
          onPress={() =>
            banner.parcel_id ? router.push(`/parcel/${banner.parcel_id}`) : router.push('/alerts')
          }
        />
      ) : null}

      {list.length > 0 ? (
        <>
          <MonoLabel style={styles.listMeta}>{metaParts.join(' · ')}</MonoLabel>
          <View style={styles.scoreExplainer}>
            <Ionicons name="sparkles-outline" size={16} color={colors.primary} />
            <View style={styles.flex1}>
              <Text style={styles.scoreExplainerTitle}>{t('score.name')}</Text>
              <Text style={styles.scoreExplainerBody}>{t('score.short_explanation')}</Text>
            </View>
          </View>
        </>
      ) : null}
    </View>
  );

  if (parcels.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (parcels.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{t('dashboard.load_error')}</Text>
        <Pressable style={styles.cta} onPress={() => parcels.refetch()}>
          <Text style={styles.ctaText}>{t('common.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <FlatList
        data={list}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.content}
        ListHeaderComponent={header}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        renderItem={({ item }) => (
          <ParcelRow
            parcel={item}
            latest={latest.data?.[item.id]}
            status={statusForSeverity(severityByParcel[item.id])}
            onPress={() => router.push(`/parcel/${item.id}`)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{t('dashboard.empty_title')}</Text>
            <Text style={styles.emptyBody}>{t('dashboard.empty_body')}</Text>
            <Pressable style={styles.cta} onPress={() => router.push('/parcel/new')}>
              <Text style={styles.ctaText}>{t('dashboard.empty_cta')}</Text>
            </Pressable>
          </View>
        }
      />
    </View>
  );
}

function BannerCard({
  alert,
  parcelName,
  onPress,
}: {
  alert: Alert;
  parcelName?: string;
  onPress: () => void;
}) {
  const tint = severityTint[alert.severity];
  return (
    <Pressable onPress={onPress} style={({ pressed }) => (pressed ? styles.pressed : null)}>
      <TintCard gradient={severityGradient(alert.severity)} style={styles.banner}>
        <GlyphBadge glyph={kindGlyph(alert.kind)} fg={tint.fg} bg={tint.bg} size={26} />
        <View style={styles.flex1}>
          <Text style={styles.bannerTitle} numberOfLines={1}>
            {alert.title}
            {parcelName ? ` — ${parcelName}` : ''}
          </Text>
          <Text style={styles.bannerBody} numberOfLines={1}>
            {alert.message}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
      </TintCard>
    </Pressable>
  );
}

function ParcelRow({
  parcel,
  latest,
  status,
  onPress,
}: {
  parcel: Parcel;
  latest: LatestIndices | undefined;
  status: Status;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const crop = cropLabel(parcel.crop);
  const score = arvoScore(latest);

  // 7-day delta from the cached series (shared with the parcel detail chart)
  const { data } = useQuery({
    queryKey: ['indices', parcel.id, 'ndvi', 'spark'],
    queryFn: () =>
      api.get<{ index: IndexName; series: IndexPoint[] }>(`/parcels/${parcel.id}/indices?index=ndvi`),
    staleTime: 5 * 60 * 1000,
  });
  let delta: number | null = null;
  const series = data?.series ?? [];
  if (series.length >= 2) {
    const last = series[series.length - 1];
    const lastT = parseISO(last.observed_at).getTime();
    // closest observation at least ~7 days before the latest one
    const ref = [...series]
      .reverse()
      .find((p) => lastT - parseISO(p.observed_at).getTime() >= 6.5 * DAY_MS);
    if (ref) delta = last.mean - ref.mean;
  }

  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.pressed]} onPress={onPress}>
      <View style={[styles.scoreBadge, { backgroundColor: scoreColor(score?.value) }]}>
        <Text style={styles.scoreValue}>{score?.value ?? '—'}</Text>
      </View>
      <View style={styles.rowInfo}>
        <Text style={styles.rowName} numberOfLines={1}>
          {parcel.name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {[crop, `${parcel.area_ha.toFixed(1)} ha`].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <StatusChip status={status} label={t(`status.${status}`)} />
        <View style={styles.trendRow}>
          <Ionicons
            name={trendBand(delta) === 'improving' ? 'trending-up' : trendBand(delta) === 'declining' ? 'trending-down' : 'remove'}
            size={14}
            color={trendBand(delta) === 'declining' ? colors.accent : colors.primary}
          />
          <Text style={styles.trendText}>{t(`trend.${trendBand(delta)}`)}</Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    gap: spacing.md,
  },
  content: { padding: spacing.md, gap: spacing.sm, flexGrow: 1 },
  flex1: { flex: 1 },
  header: { marginBottom: spacing.xs, gap: spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { fontFamily: fonts.displayBold, fontSize: 28, color: colors.text },
  org: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, marginTop: 2 },
  bell: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    minWidth: 15,
    height: 15,
    borderRadius: 7.5,
    paddingHorizontal: 3,
    backgroundColor: colors.accent,
    borderWidth: 1.5,
    borderColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellBadgeText: { fontFamily: fonts.bodyBold, fontSize: 9, color: '#FFFFFF' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bannerTitle: { fontFamily: fonts.bodyBold, fontSize: 13, color: colors.text },
  bannerBody: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, marginTop: 1 },
  listMeta: { marginTop: spacing.xs },
  scoreExplainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
  },
  scoreExplainerTitle: { fontFamily: fonts.bodyBold, fontSize: 12, color: colors.primaryDark },
  scoreExplainerBody: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted, marginTop: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pressed: { opacity: 0.7 },
  rowInfo: { flex: 1 },
  rowName: { fontFamily: fonts.display, fontSize: 16, color: colors.text },
  rowMeta: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, marginTop: 2 },
  rowRight: { alignItems: 'flex-end', gap: 6 },
  scoreBadge: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: colors.card,
  },
  scoreValue: { fontFamily: fonts.monoSemiBold, fontSize: 14, color: '#FFFFFF' },
  trendRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  trendText: { fontFamily: fonts.bodyMedium, fontSize: 10.5, color: colors.textMuted },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xl },
  emptyTitle: { fontFamily: fonts.display, fontSize: 18, color: colors.text },
  emptyBody: { fontFamily: fonts.body, fontSize: 14, color: colors.textMuted, textAlign: 'center' },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    marginTop: spacing.sm,
  },
  ctaText: { fontFamily: fonts.bodyBold, color: colors.onPrimary, fontSize: 15 },
  errorText: { fontFamily: fonts.body, color: colors.danger, fontSize: 14 },
});

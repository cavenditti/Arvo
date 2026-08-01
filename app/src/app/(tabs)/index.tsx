// OWNER: dashboard — Campi home: header with weather/scouting/alerts shortcuts, grouped
// attention banner, human meta line, and one status voice per row (deriveFieldStatus +
// trendFromSeries — no local status/delta logic, docs/UX-REVAMP.md).
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { differenceInCalendarDays, isToday, isValid, isYesterday, parseISO } from 'date-fns';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api } from '@/api/client';
import type { Alert, LatestIndices, Org, Parcel, Role, User } from '@/api/types';
import { kindGlyph } from '@/components/glyphs';
import { StaleBanner } from '@/components/StaleBanner';
import { GlyphBadge, StatusChip, TintCard } from '@/components/ui';
import { arvoScoreDetail, cropLabel, scoreColor } from '@/features/insights/format';
import { countAlertEvents, groupAlerts, type AlertEvent } from '@/features/insights/grouping';
import { deriveFieldStatus, trendFromSeries } from '@/features/insights/status';
import { useIndexSeries, useLatestIndices, useParcels } from '@/features/parcels/hooks';
import { useParcelNames } from '@/features/parcels/names';
import { formatHectares } from '@/lib/format';
import {
  colors,
  fonts,
  gradients,
  radius,
  severityGradient,
  severityTint,
  spacing,
  touch,
  type as typeScale,
  type Status,
} from '@/theme';

type Me = { user: User; org: Org; role: Role };

const HIT_SLOP = { top: 4, right: 4, bottom: 4, left: 4 }; // 40pt glyph buttons → 48pt targets

export default function Dashboard() {
  const { t } = useTranslation();
  const router = useRouter();
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);

  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: () => api.get<Me>('/auth/me') });
  const parcels = useParcels();

  const ids = (parcels.data ?? []).map((p) => p.id);
  // Shared hook so the cache key matches every other consumer of the batch endpoint.
  const latest = useLatestIndices(ids);
  const openAlerts = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: () => api.get<Alert[]>('/alerts?state=open'),
  });

  const parcelNames = useParcelNames();

  // One grouped-event view of the open alerts: banner = worst/latest event, badge = event
  // count, per-row status = events of that parcel. Same grouping as the alerts tab.
  const events = useMemo(
    () => groupAlerts(openAlerts.data ?? [], (id) => (id ? (parcelNames[id] ?? '') : '')),
    [openAlerts.data, parcelNames],
  );
  const openEventsByParcel = useMemo(() => {
    const byParcel: Record<string, Alert[]> = {};
    for (const a of openAlerts.data ?? []) {
      if (!a.parcel_id) continue;
      (byParcel[a.parcel_id] ??= []).push(a);
    }
    const counts: Record<string, number> = {};
    for (const [id, list] of Object.entries(byParcel)) counts[id] = countAlertEvents(list);
    return counts;
  }, [openAlerts.data]);
  const eventCount = countAlertEvents(openAlerts.data ?? []);
  const bannerEvent = events[0];

  // Latest satellite acquisition across parcels (drone rollups don't count as a "pass").
  let lastPass: string | null = null;
  for (const li of Object.values(latest.data ?? {})) {
    for (const point of Object.values(li)) {
      if (!point || point.source === 'drone') continue;
      if (!lastPass || point.observed_at > lastPass) lastPass = point.observed_at;
    }
  }

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await qc.invalidateQueries();
    setRefreshing(false);
  }, [qc]);

  const list = parcels.data ?? [];

  // "3 campi · foto satellitare di ieri" — relative day in plain words, never a raw date.
  const passDate = lastPass ? parseISO(lastPass) : null;
  let when: string | null = null;
  if (passDate && isValid(passDate)) {
    when = isToday(passDate)
      ? t('dashboard.when_today', { defaultValue: 'di oggi' })
      : isYesterday(passDate)
        ? t('dashboard.when_yesterday', { defaultValue: 'di ieri' })
        : t('dashboard.when_days_ago', {
            days: differenceInCalendarDays(new Date(), passDate),
            defaultValue: 'di {{days}} giorni fa',
          });
  }
  const metaLine = when
    ? t('dashboard.meta_line', {
        count: list.length,
        when,
        defaultValue_one: '{{count}} campo · foto satellitare {{when}}',
        defaultValue_other: '{{count}} campi · foto satellitare {{when}}',
        defaultValue: '{{count}} campi · foto satellitare {{when}}',
      })
    : t('dashboard.parcel_count', { count: list.length });

  // Every field exists but none has a score yet → quiet "first satellite photos on the way".
  const allPending =
    list.length > 0 &&
    latest.isSuccess &&
    list.every((p) => arvoScoreDetail(latest.data?.[p.id]).score == null);

  const header = (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <View style={styles.flex1}>
          <Text style={styles.title} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('dashboard.title')}
          </Text>
          <Text style={styles.org} maxFontSizeMultiplier={typeScale.maxMult}>
            {me.data?.org.name ?? '—'}
          </Text>
        </View>
        <Pressable
          onPress={() => router.push('/weather')}
          style={styles.headerButton}
          hitSlop={HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={t('dashboard.weather_link', { defaultValue: 'Meteo' })}
        >
          <Ionicons name="partly-sunny-outline" size={20} color={colors.text} />
        </Pressable>
        <Pressable
          onPress={() => router.push('/scouting')}
          style={styles.headerButton}
          hitSlop={HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={t('scouting.open_list')}
        >
          <Ionicons name="journal-outline" size={20} color={colors.text} />
        </Pressable>
        <Pressable
          onPress={() => router.push('/alerts')}
          style={styles.headerButton}
          hitSlop={HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={t('tabs.alerts')}
        >
          <Ionicons name="notifications-outline" size={20} color={colors.text} />
          {eventCount > 0 ? (
            <View style={styles.bellBadge}>
              <Text style={styles.bellBadgeText} maxFontSizeMultiplier={typeScale.maxMult}>
                {eventCount > 99 ? '99+' : eventCount}
              </Text>
            </View>
          ) : null}
        </Pressable>
      </View>

      <StaleBanner updatedAt={parcels.dataUpdatedAt > 0 ? parcels.dataUpdatedAt : null} />

      {bannerEvent ? (
        <AttentionBanner event={bannerEvent} onPress={() => router.push('/alerts')} />
      ) : null}

      {allPending ? (
        <TintCard gradient={gradients.eucalyptus} style={styles.firstValue}>
          <Text style={styles.firstValueTitle} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('onboarding.first_value_title')}
          </Text>
          <Text style={styles.firstValueBody} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('onboarding.first_value_body')}
          </Text>
        </TintCard>
      ) : null}

      {list.length > 0 ? (
        <>
          <Text style={styles.listMeta} maxFontSizeMultiplier={typeScale.maxMult}>
            {metaLine}
          </Text>
          <View style={styles.scoreExplainer}>
            <Ionicons name="sparkles-outline" size={16} color={colors.primary} />
            <View style={styles.flex1}>
              <Text style={styles.scoreExplainerTitle} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('score.name')}
              </Text>
              <Text style={styles.scoreExplainerBody} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('score.short_explanation')}
              </Text>
            </View>
          </View>
        </>
      ) : null}
    </View>
  );

  if (parcels.isLoading) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.content}>
          {header}
          <View style={styles.skeletonGroup} accessibilityLabel={t('common.loading')}>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </View>
        </View>
      </View>
    );
  }

  if (parcels.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('dashboard.load_error')}
        </Text>
        <Pressable
          style={styles.cta}
          onPress={() => parcels.refetch()}
          accessibilityRole="button"
          accessibilityLabel={t('common.retry')}
        >
          <Text style={styles.ctaText} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('common.retry')}
          </Text>
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
            openAlertEvents={openEventsByParcel[item.id] ?? 0}
            onPress={() => router.push(`/parcel/${item.id}`)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('dashboard.empty_title')}
            </Text>
            <Text style={styles.emptyBody} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('dashboard.empty_body')}
            </Text>
            <Pressable
              style={styles.cta}
              onPress={() => router.push('/parcel/new')}
              accessibilityRole="button"
              accessibilityLabel={t('onboarding.add_first_field')}
            >
              <Text style={styles.ctaText} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('onboarding.add_first_field')}
              </Text>
            </Pressable>
          </View>
        }
      />
    </View>
  );
}

/**
 * Worst/latest grouped event, in plain language: title carries the parcel name via
 * titleParams; plant IDs and index values stay behind the alerts tab's technical
 * disclosure. `body_single` is the raw detector message (may lead with NDVI) — skipped
 * here so the banner never shows jargon.
 */
function AttentionBanner({ event, onPress }: { event: AlertEvent; onPress: () => void }) {
  const { t } = useTranslation();
  const tint = severityTint[event.severity] ?? severityTint.info;
  const showBody = event.bodyKey !== 'alerts_group.body_single';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => (pressed ? styles.pressed : null)}
    >
      <TintCard gradient={severityGradient(event.severity)} style={styles.banner}>
        <GlyphBadge glyph={kindGlyph(event.kind)} fg={tint.fg} bg={tint.bg} size={26} />
        <View style={styles.flex1}>
          <Text style={styles.bannerTitle} numberOfLines={2} maxFontSizeMultiplier={typeScale.maxMult}>
            {t(event.titleKey, event.titleParams)}
          </Text>
          {showBody ? (
            <Text style={styles.bannerBody} numberOfLines={2} maxFontSizeMultiplier={typeScale.maxMult}>
              {t(event.bodyKey, event.bodyParams)}
            </Text>
          ) : null}
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
      </TintCard>
    </Pressable>
  );
}

function ParcelRow({
  parcel,
  latest,
  openAlertEvents,
  onPress,
}: {
  parcel: Parcel;
  latest: LatestIndices | undefined;
  openAlertEvents: number;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const crop = cropLabel(parcel.crop);

  // Same cache entry as the parcel-detail chart; status/trend come ONLY from status.ts.
  const { data } = useIndexSeries(parcel.id, 'ndvi');
  const trend = trendFromSeries(
    (data?.series ?? []).map((p) => ({ date: p.observed_at, value: p.mean })),
  );
  const { score, coverage } = arvoScoreDetail(latest);
  const fs = deriveFieldStatus({ score, trend, openAlertEvents, coverage });
  const chipStatus: Status = fs.level === 'ok' ? 'healthy' : fs.level;
  const chipLabel = t(fs.chipKey);

  const trendIcon =
    trend.direction === 'up' ? 'trending-up' : trend.direction === 'down' ? 'trending-down' : 'remove';
  const trendColor =
    trend.direction === 'down'
      ? colors.accent
      : trend.direction === 'up'
        ? colors.success
        : colors.textMuted;

  const a11yLabel =
    score != null
      ? t('dashboard.row_a11y', {
          name: parcel.name,
          score,
          status: chipLabel,
          defaultValue: '{{name}}, punteggio {{score}}, {{status}}',
        })
      : t('dashboard.row_a11y_pending', {
          name: parcel.name,
          status: chipLabel,
          defaultValue: '{{name}}, in attesa dei primi dati, {{status}}',
        });

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
    >
      <View style={[styles.scoreBadge, { backgroundColor: scoreColor(score) }]}>
        <Text style={styles.scoreValue} maxFontSizeMultiplier={typeScale.maxMult}>
          {score ?? '—'}
        </Text>
      </View>
      <View style={styles.rowInfo}>
        <Text style={styles.rowName} numberOfLines={1} maxFontSizeMultiplier={typeScale.maxMult}>
          {parcel.name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1} maxFontSizeMultiplier={typeScale.maxMult}>
          {[crop, formatHectares(parcel.area_ha)].filter(Boolean).join(' · ')}
        </Text>
        {fs.partial && score != null ? (
          <Text style={styles.partialText} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('status.partial')}
          </Text>
        ) : null}
      </View>
      <View style={styles.rowRight}>
        <StatusChip status={chipStatus} label={chipLabel} />
        <View style={styles.trendRow}>
          <Ionicons name={trendIcon} size={14} color={trendColor} />
          <Text style={styles.trendText} maxFontSizeMultiplier={typeScale.maxMult}>
            {t(trend.labelKey)}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

/** Plain placeholder row while the first parcels load — no spinner, no animation. */
function SkeletonRow() {
  return (
    <View style={styles.row}>
      <View style={styles.skeletonCircle} />
      <View style={styles.rowInfo}>
        <View style={[styles.skeletonBar, styles.skeletonBarWide]} />
        <View style={[styles.skeletonBar, styles.skeletonBarNarrow]} />
      </View>
      <View style={styles.skeletonChip} />
    </View>
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
  headerButton: {
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
    minHeight: touch.min,
  },
  bannerTitle: { fontFamily: fonts.bodyBold, fontSize: 13, color: colors.text },
  bannerBody: { fontFamily: fonts.body, fontSize: typeScale.caption, color: colors.textMuted, marginTop: 1 },
  firstValue: { padding: spacing.md, gap: 2 },
  firstValueTitle: { fontFamily: fonts.bodyBold, fontSize: typeScale.body, color: colors.text },
  firstValueBody: { fontFamily: fonts.body, fontSize: typeScale.caption, color: colors.textMuted },
  listMeta: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  scoreExplainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
  },
  scoreExplainerTitle: { fontFamily: fonts.bodyBold, fontSize: typeScale.caption, color: colors.primaryDark },
  scoreExplainerBody: { fontFamily: fonts.body, fontSize: typeScale.caption, color: colors.textMuted, marginTop: 1 },
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
  rowName: { fontFamily: fonts.display, fontSize: typeScale.bodyLg, color: colors.text },
  rowMeta: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, marginTop: 2 },
  partialText: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    color: colors.textFaint,
    marginTop: 2,
  },
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
  trendText: { fontFamily: fonts.bodyMedium, fontSize: typeScale.caption, color: colors.textMuted },
  skeletonGroup: { gap: spacing.sm },
  skeletonCircle: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.border },
  skeletonBar: { height: 12, borderRadius: radius.sm, backgroundColor: colors.border },
  skeletonBarWide: { width: '60%' },
  skeletonBarNarrow: { width: '40%', marginTop: spacing.sm },
  skeletonChip: { width: 88, height: 28, borderRadius: radius.pill, backgroundColor: colors.border },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xl },
  emptyTitle: { fontFamily: fonts.display, fontSize: typeScale.title, color: colors.text },
  emptyBody: { fontFamily: fonts.body, fontSize: typeScale.body, color: colors.textMuted, textAlign: 'center' },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    marginTop: spacing.sm,
    minHeight: touch.min,
    justifyContent: 'center',
  },
  ctaText: { fontFamily: fonts.bodyBold, color: colors.onPrimary, fontSize: 15 },
  errorText: { fontFamily: fonts.body, color: colors.danger, fontSize: typeScale.body },
});

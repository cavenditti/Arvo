// OWNER: dashboard — Campi home: header with weather/scouting/alerts shortcuts, grouped
// attention banner, human meta line, and one status voice per row (deriveFieldStatus +
// trendFromSeries — no local status/delta logic, docs/UX-REVAMP.md).
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { differenceInCalendarDays, isToday, isValid, isYesterday, parseISO } from 'date-fns';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
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
import type { Alert, LatestIndices, Org, Parcel, Role, User } from '@/api/types';
import { kindGlyph } from '@/components/glyphs';
import { StaleBanner } from '@/components/StaleBanner';
import { Card, GlassIconButton, GlyphBadge, InteractivePressable, StatusChip, TintCard } from '@/components/ui';
import { arvoScoreDetail, cropLabel, scoreColor } from '@/features/insights/format';
import { countAlertEvents, groupAlerts, type AlertEvent } from '@/features/insights/grouping';
import { deriveFieldStatus, trendFromSeries } from '@/features/insights/status';
import {
  imageryIsActive,
  type ImageryRefreshStatus,
  useImageryStatuses,
  useIndexSeries,
  useLatestIndices,
  useParcels,
} from '@/features/parcels/hooks';
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
  navigationMetrics,
} from '@/theme';

type Me = { user: User; org: Org; role: Role };

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
  const imageryStatuses = useImageryStatuses(ids);
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

  // A missing score is not a running job. Animate only a persisted queued/running refresh.
  const anyProcessing = list.some((p) => imageryIsActive(imageryStatuses.data?.[p.id]));

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
        <GlassIconButton
          onPress={() => router.push('/weather-details')}
          haptic
          accessibilityRole="button"
          accessibilityLabel={t('dashboard.weather_link', { defaultValue: 'Meteo' })}
        >
          <Ionicons name="partly-sunny-outline" size={20} color={colors.text} />
        </GlassIconButton>
        <GlassIconButton
          onPress={() => router.push('/scouting')}
          haptic
          accessibilityRole="button"
          accessibilityLabel={t('scouting.open_list')}
        >
          <Ionicons name="journal-outline" size={20} color={colors.text} />
        </GlassIconButton>
      </View>

      <StaleBanner updatedAt={parcels.dataUpdatedAt > 0 ? parcels.dataUpdatedAt : null} />

      {bannerEvent ? (
        <AttentionBanner event={bannerEvent} onPress={() => router.push('/alerts')} />
      ) : null}

      {anyProcessing ? (
        <TintCard gradient={gradients.eucalyptus} style={styles.firstValue}>
          <View style={styles.processingTitleRow}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.firstValueTitle} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('parcel.data_processing_title')}
            </Text>
          </View>
        </TintCard>
      ) : null}

      {/* The score explains itself on the parcel screen ("Come funziona il punteggio");
          no permanent explainer strip here — the list is the screen. */}
      {list.length > 0 ? (
        <Text style={styles.listMeta} maxFontSizeMultiplier={typeScale.maxMult}>
          {metaLine}
        </Text>
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
    <View style={styles.root}>
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
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
            imageryStatus={imageryStatuses.data?.[item.id]}
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
 * disclosure. The dashboard is only a pointer to the event, never its explanation.
 */
function AttentionBanner({ event, onPress }: { event: AlertEvent; onPress: () => void }) {
  const { t } = useTranslation();
  const tint = severityTint[event.severity] ?? severityTint.info;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => (pressed ? styles.pressed : null)}
    >
      <TintCard gradient={severityGradient(event.severity)} style={styles.banner}>
        <GlyphBadge glyph={kindGlyph(event.kind)} fg={tint.fg} bg={tint.bg} size={26} />
        <Text
          style={[styles.bannerTitle, styles.flex1]}
          numberOfLines={2}
          maxFontSizeMultiplier={typeScale.maxMult}
        >
          {t(event.titleKey, event.titleParams)}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
      </TintCard>
    </Pressable>
  );
}

function ParcelRow({
  parcel,
  latest,
  imageryStatus,
  openAlertEvents,
  onPress,
}: {
  parcel: Parcel;
  latest: LatestIndices | undefined;
  imageryStatus: ImageryRefreshStatus | undefined;
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
  const dataPending = score == null && imageryIsActive(imageryStatus);
  const dataUnavailable = score == null && !dataPending;
  const refreshFailed = imageryStatus?.state === 'failed';
  const fs = deriveFieldStatus({ score, trend, openAlertEvents, coverage });
  const chipStatus: Status = fs.level === 'ok' ? 'healthy' : fs.level;
  const chipLabel = t(fs.chipKey);
  const trendLabel = t(trend.labelKey);

  const a11yLabel =
    score != null
      ? t('dashboard.row_a11y', {
          name: parcel.name,
          score,
          status: chipLabel,
          trend: trendLabel,
          defaultValue: '{{name}}, punteggio {{score}}, {{status}}, {{trend}}',
        })
      : t('dashboard.row_a11y_pending', {
          name: parcel.name,
          status: chipLabel,
          trend: trendLabel,
          defaultValue: '{{name}}, in attesa dei primi dati, {{status}}, {{trend}}',
        });

  return (
    <InteractivePressable
      style={styles.rowTouch}
      pressedStyle={styles.rowPressed}
      haptic
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
    >
      <Card style={styles.row}>
        <View style={[styles.scoreBadge, { backgroundColor: scoreColor(score) }]}>
          {dataPending ? (
            <Ionicons name="cloud-download-outline" size={20} color={colors.onPrimary} />
          ) : (
            <Text style={styles.scoreValue} maxFontSizeMultiplier={typeScale.maxMult}>
              {score ?? '—'}
            </Text>
          )}
        </View>
        <View style={styles.rowInfo}>
          <Text style={styles.rowName} numberOfLines={1} maxFontSizeMultiplier={typeScale.maxMult}>
            {parcel.name}
          </Text>
          <Text style={styles.rowMeta} numberOfLines={1} maxFontSizeMultiplier={typeScale.maxMult}>
            {[crop, formatHectares(parcel.area_ha)].filter(Boolean).join(' · ')}
          </Text>
          {dataPending ? (
            <View style={styles.processingLine}>
              <Text
                style={styles.processingText}
                maxFontSizeMultiplier={typeScale.maxMult}
                numberOfLines={2}
              >
                {t('parcel.data_processing_short')}
              </Text>
            </View>
          ) : dataUnavailable ? (
            <View style={styles.processingLine}>
              <Ionicons name="alert-circle-outline" size={14} color={colors.textMuted} />
              <Text
                style={[styles.processingText, styles.unavailableText]}
                maxFontSizeMultiplier={typeScale.maxMult}
                numberOfLines={2}
              >
                {t(
                  refreshFailed
                    ? 'parcel.data_refresh_failed_short'
                    : 'parcel.data_unavailable_short',
                )}
              </Text>
            </View>
          ) : fs.partial ? (
            <Text style={styles.partialText} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('status.partial')}
            </Text>
          ) : null}
        </View>
        <View style={styles.rowRight}>
          {dataPending || dataUnavailable ? (
            <Ionicons name="chevron-forward" size={17} color={colors.textFaint} />
          ) : (
            <StatusChip status={chipStatus} label={chipLabel} />
          )}
        </View>
      </Card>
    </InteractivePressable>
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
  content: {
    padding: spacing.md,
    paddingBottom: navigationMetrics.contentBottomInset,
    gap: spacing.sm,
    flexGrow: 1,
  },
  flex1: { flex: 1 },
  header: { marginBottom: spacing.xs, gap: spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { fontFamily: fonts.displayBold, fontSize: 28, color: colors.text },
  org: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, marginTop: 2 },
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
  firstValue: { padding: spacing.md, gap: 2 },
  firstValueTitle: { fontFamily: fonts.bodyBold, fontSize: typeScale.body, color: colors.text },
  processingTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  listMeta: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  rowTouch: { borderRadius: radius.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pressed: { opacity: 0.7 },
  rowPressed: { transform: [{ scale: 0.985 }] },
  rowInfo: { flex: 1 },
  rowName: { fontFamily: fonts.display, fontSize: typeScale.bodyLg, color: colors.text },
  rowMeta: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, marginTop: 2 },
  partialText: {
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    color: colors.textFaint,
    marginTop: 2,
  },
  processingLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: 4,
  },
  processingText: {
    flex: 1,
    fontFamily: fonts.bodyMedium,
    fontSize: typeScale.caption,
    color: colors.primary,
  },
  unavailableText: { color: colors.textMuted },
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

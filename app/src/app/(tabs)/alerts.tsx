// OWNER: alert-grouping — Insights tab (Campo): alerts grouped into agronomic events
// (features/insights/grouping.ts). Header + segmented control count EVENTS, with the raw
// signal count as a secondary "43 segnali raggruppati in 6 eventi" line. Bulk optimistic
// confirm/snooze/dismiss over the per-alert endpoints (one invalidation per batch), a real
// error state with retry, and the decision-support disclaimer.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api } from '@/api/client';
import type { Alert, AlertState, Parcel } from '@/api/types';
import AlertList from '@/components/AlertList';
import { InteractivePressable } from '@/components/ui';
import { countAlertEvents } from '@/features/insights/grouping';
import { colors, fonts, radius, spacing, touch, type as typeScale } from '@/theme';

type Filter = 'open' | 'all';
type BulkAction = 'ack' | 'snooze' | 'dismiss';
const DAY_MS = 86_400_000;
// both list caches get the optimistic flip, whatever filter is active
const LIST_KEYS: readonly ['alerts', Filter][] = [
  ['alerts', 'open'],
  ['alerts', 'all'],
];

export default function AlertsScreen() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<Filter>('open');

  const parcels = useQuery({ queryKey: ['parcels'], queryFn: () => api.get<Parcel[]>('/parcels') });
  // both lists regardless of active filter (['alerts', filter] hits one of these two caches,
  // which the layout badge shares as well)
  const openQ = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: () => api.get<Alert[]>('/alerts?state=open'),
  });
  const allQ = useQuery({
    queryKey: ['alerts', 'all'],
    queryFn: () => api.get<Alert[]>('/alerts'),
  });
  const active = filter === 'open' ? openQ : allQ;
  const list = active.data ?? [];

  // header + segmented control speak in EVENTS, not raw signals
  const openEvents = countAlertEvents(openQ.data ?? []);
  const allEvents = countAlertEvents(allQ.data ?? []);
  // "new" = created in the 24h before the last successful fetch (pure across re-renders)
  const freshEvents = countAlertEvents(
    (openQ.data ?? []).filter(
      (a) => openQ.dataUpdatedAt - new Date(a.created_at).getTime() < DAY_MS,
    ),
  );

  const parcelNames: Record<string, string> = {};
  for (const p of parcels.data ?? []) parcelNames[p.id] = p.name;
  const parcelName = (id: string | null) => (id ? (parcelNames[id] ?? '') : '');

  const mutation = useMutation({
    mutationFn: ({ ids, action, days }: { ids: string[]; action: BulkAction; days?: number }) => {
      if (action === 'snooze') {
        const until = new Date(Date.now() + (days ?? 3) * DAY_MS).toISOString();
        return Promise.all(ids.map((id) => api.post<Alert>(`/alerts/${id}/snooze`, { until })));
      }
      return Promise.all(ids.map((id) => api.post<Alert>(`/alerts/${id}/${action}`)));
    },
    onMutate: async ({ ids, action }) => {
      await qc.cancelQueries({ queryKey: ['alerts'] });
      const marked = new Set(ids);
      const nextState: AlertState =
        action === 'ack' ? 'acked' : action === 'dismiss' ? 'dismissed' : 'snoozed';
      const prev = LIST_KEYS.map((key) => [key, qc.getQueryData<Alert[]>(key)] as const);
      for (const [key, data] of prev) {
        if (!data) continue;
        const next = data.map((a) => (marked.has(a.id) ? { ...a, state: nextState } : a));
        // any action removes the alerts from the "open" list
        qc.setQueryData(key, key[1] === 'open' ? next.filter((a) => !marked.has(a.id)) : next);
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      for (const [key, data] of ctx?.prev ?? []) {
        if (data) qc.setQueryData(key, data);
      }
    },
    // one invalidation per batch — badges, banners and parcel panels refresh together
    onSettled: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  });

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('alerts.title')}
        </Text>
        {/* One meta line; the signals-vs-events accounting lives inside each card's
            "Dettagli tecnici" — the header stays quiet. */}
        <Text style={styles.subtitle} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('alerts.header_meta', { open: openEvents, fresh: freshEvents })}
        </Text>
      </View>

      <View style={styles.segment}>
        <SegBtn
          label={`${t('alerts.filter_open')} · ${openEvents}`}
          active={filter === 'open'}
          onPress={() => setFilter('open')}
        />
        <SegBtn
          label={`${t('alerts.filter_all')} · ${allEvents}`}
          active={filter === 'all'}
          onPress={() => setFilter('all')}
        />
      </View>

      {active.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : active.isError && !active.data ? (
        // a failed fetch must never masquerade as "all good" on the risk screen
        <View style={styles.center}>
          <Ionicons name="warning-outline" size={32} color={colors.warning} />
          <Text style={styles.errorText} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('alerts_group.load_error', {
              defaultValue: 'Non riesco a caricare le segnalazioni. Controlla la connessione e riprova.',
            })}
          </Text>
          <InteractivePressable
            onPress={() => {
              void active.refetch();
              void parcels.refetch();
            }}
            style={styles.retryBtn}
            hoverStyle={styles.retryHover}
          >
            <Text style={styles.retryText} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('common.retry')}
            </Text>
          </InteractivePressable>
        </View>
      ) : list.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText} maxFontSizeMultiplier={typeScale.maxMult}>
            {filter === 'open' ? t('alerts.empty_open') : t('alerts.empty')}
          </Text>
        </View>
      ) : (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.content}
        >
          <AlertList
            alerts={list}
            parcelName={parcelName}
            onConfirm={(ids) => mutation.mutate({ ids, action: 'ack' })}
            onSnooze={(ids, days) => mutation.mutate({ ids, action: 'snooze', days })}
            onDismiss={(ids) => mutation.mutate({ ids, action: 'dismiss' })}
          />
          {/* Decision-support disclaimer: still present, but as a quiet footer instead of
              a banner standing between the farmer and the first card. */}
          <Text style={styles.footerNote} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('alerts.note')}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

function SegBtn({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <InteractivePressable
      onPress={onPress}
      accessibilityState={{ selected: active }}
      style={[styles.segBtn, active && styles.segBtnActive]}
      hoverStyle={styles.segHover}
    >
      <Text
        style={[styles.segText, active && styles.segTextActive]}
        maxFontSizeMultiplier={typeScale.maxMult}
      >
        {label}
      </Text>
    </InteractivePressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  title: {
    fontFamily: fonts.displayBold,
    fontSize: 28,
    color: colors.text,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontFamily: fonts.body,
    fontSize: typeScale.caption + 1,
    color: colors.textMuted,
    marginTop: 2,
  },
  segment: {
    flexDirection: 'row',
    margin: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.borderSoft,
    padding: 3,
  },
  segBtn: {
    flex: 1,
    minHeight: touch.chip,
    justifyContent: 'center',
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  segBtnActive: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  segHover: { backgroundColor: colors.card },
  segText: { fontFamily: fonts.bodySemiBold, fontSize: typeScale.body, color: colors.textMuted },
  segTextActive: { color: colors.text },
  content: { padding: spacing.md, paddingTop: 0, gap: spacing.sm },
  footerNote: {
    fontFamily: fonts.body,
    fontSize: typeScale.caption,
    color: colors.textFaint,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  emptyText: { fontFamily: fonts.body, color: colors.textMuted, fontSize: typeScale.body },
  errorText: {
    fontFamily: fonts.body,
    color: colors.textMuted,
    fontSize: typeScale.body,
    textAlign: 'center',
    lineHeight: 20,
  },
  retryBtn: {
    minHeight: touch.min,
    minWidth: 120,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    marginTop: spacing.xs,
  },
  retryHover: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  retryText: { fontFamily: fonts.bodySemiBold, fontSize: typeScale.body, color: colors.primaryDark },
});

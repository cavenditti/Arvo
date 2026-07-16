// OWNER: fe-dashboard — Insights tab (Campo): header with open/new counts, counted Open|All
// segment, decision-support note, AlertList with optimistic ack/snooze/dismiss + open-parcel link.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api } from '@/api/client';
import type { Alert, AlertState, Parcel } from '@/api/types';
import AlertList from '@/components/AlertList';
import type { AlertAction } from '@/components/types';
import { readSnoozeDays } from '@/features/insights/snooze';
import { colors, fonts, radius, spacing } from '@/theme';
import { useRouter } from 'expo-router';

type Filter = 'open' | 'all';
const DAY_MS = 86_400_000;

export default function AlertsScreen() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<Filter>('open');

  const parcels = useQuery({ queryKey: ['parcels'], queryFn: () => api.get<Parcel[]>('/parcels') });
  const alerts = useQuery({
    queryKey: ['alerts', filter],
    queryFn: () => api.get<Alert[]>(filter === 'open' ? '/alerts?state=open' : '/alerts'),
  });
  // both counts regardless of active filter (shares the cache with the layout badge)
  const openQ = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: () => api.get<Alert[]>('/alerts?state=open'),
  });
  const allQ = useQuery({
    queryKey: ['alerts', 'all'],
    queryFn: () => api.get<Alert[]>('/alerts'),
  });

  const openCount = openQ.data?.length ?? 0;
  const allCount = allQ.data?.length ?? 0;
  const newCount = (openQ.data ?? []).filter(
    (a) => Date.now() - new Date(a.created_at).getTime() < DAY_MS,
  ).length;

  const parcelNames: Record<string, string> = {};
  for (const p of parcels.data ?? []) parcelNames[p.id] = p.name;

  const mutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: AlertAction }) => {
      if (action === 'ack') return api.post<Alert>(`/alerts/${id}/ack`);
      if (action === 'dismiss') return api.post<Alert>(`/alerts/${id}/dismiss`);
      const until = new Date(Date.now() + readSnoozeDays() * DAY_MS).toISOString();
      return api.post<Alert>(`/alerts/${id}/snooze`, { until });
    },
    onMutate: async ({ id, action }) => {
      const key = ['alerts', filter];
      await qc.cancelQueries({ queryKey: ['alerts'] });
      const prev = qc.getQueryData<Alert[]>(key);
      if (prev) {
        const newState: AlertState =
          action === 'ack' ? 'acked' : action === 'dismiss' ? 'dismissed' : 'snoozed';
        let next = prev.map((a) => (a.id === id ? { ...a, state: newState } : a));
        // any action removes the alert from the "open" list
        if (filter === 'open') next = next.filter((a) => a.id !== id);
        qc.setQueryData(key, next);
      }
      return { key, prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  });

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('alerts.title')}</Text>
        <Text style={styles.subtitle}>
          {t('alerts.header_meta', { open: openCount, fresh: newCount })}
        </Text>
      </View>

      <View style={styles.segment}>
        <SegBtn
          label={`${t('alerts.filter_open')} · ${openCount}`}
          active={filter === 'open'}
          onPress={() => setFilter('open')}
        />
        <SegBtn
          label={`${t('alerts.filter_all')} · ${allCount}`}
          active={filter === 'all'}
          onPress={() => setFilter('all')}
        />
      </View>

      {alerts.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (alerts.data ?? []).length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>
            {filter === 'open' ? t('alerts.empty_open') : t('alerts.empty')}
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.note}>
            <Ionicons name="information-circle-outline" size={16} color={colors.primary} />
            <Text style={styles.noteText}>{t('alerts.note')}</Text>
          </View>
          <AlertList
            alerts={alerts.data ?? []}
            parcelNames={parcelNames}
            onAction={(id, action) => mutation.mutate({ id, action })}
            onOpenParcel={(parcelId) => router.push(`/parcel/${parcelId}`)}
          />
        </ScrollView>
      )}
    </View>
  );
}

function SegBtn({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.segBtn, active && styles.segBtnActive]}>
      <Text style={[styles.segText, active && styles.segTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  title: { fontFamily: fonts.displayBold, fontSize: 28, color: colors.text, letterSpacing: -0.5 },
  subtitle: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, marginTop: 2 },
  segment: {
    flexDirection: 'row',
    margin: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.borderSoft,
    padding: 3,
  },
  segBtn: { flex: 1, paddingVertical: spacing.sm, borderRadius: radius.sm, alignItems: 'center' },
  segBtnActive: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  segText: { fontFamily: fonts.bodySemiBold, fontSize: 14, color: colors.textMuted },
  segTextActive: { color: colors.text },
  content: { padding: spacing.md, paddingTop: 0, gap: spacing.sm },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#D3E0D5',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  noteText: { flex: 1, fontFamily: fonts.body, fontSize: 12, color: colors.primaryDark },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyText: { fontFamily: fonts.body, color: colors.textMuted, fontSize: 14 },
});

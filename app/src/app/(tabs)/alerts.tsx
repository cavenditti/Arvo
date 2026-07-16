// OWNER: fe-dashboard — Alerts tab: Aperti|Tutti filter + AlertList with optimistic ack/snooze/dismiss.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { api } from '@/api/client';
import type { Alert, AlertState, Parcel } from '@/api/types';
import AlertList from '@/components/AlertList';
import type { AlertAction } from '@/components/types';
import { readSnoozeDays } from '@/features/insights/snooze';
import { colors, radius, spacing } from '@/theme';

type Filter = 'open' | 'all';
const DAY_MS = 86_400_000;

export default function AlertsScreen() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>('open');

  const parcels = useQuery({ queryKey: ['parcels'], queryFn: () => api.get<Parcel[]>('/parcels') });
  const alerts = useQuery({
    queryKey: ['alerts', filter],
    queryFn: () => api.get<Alert[]>(filter === 'open' ? '/alerts?state=open' : '/alerts'),
  });

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
    <View style={styles.root}>
      <View style={styles.segment}>
        <SegBtn label={t('alerts.filter_open')} active={filter === 'open'} onPress={() => setFilter('open')} />
        <SegBtn label={t('alerts.filter_all')} active={filter === 'all'} onPress={() => setFilter('all')} />
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
          <AlertList
            alerts={alerts.data ?? []}
            parcelNames={parcelNames}
            onAction={(id, action) => mutation.mutate({ id, action })}
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
  segment: { flexDirection: 'row', margin: spacing.md, borderRadius: radius.md, backgroundColor: colors.border, padding: 3 },
  segBtn: { flex: 1, paddingVertical: spacing.sm, borderRadius: radius.sm, alignItems: 'center' },
  segBtnActive: { backgroundColor: colors.card },
  segText: { fontSize: 14, fontWeight: '600', color: colors.textMuted },
  segTextActive: { color: colors.primaryDark },
  content: { padding: spacing.md, paddingTop: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyText: { color: colors.textMuted, fontSize: 14 },
});

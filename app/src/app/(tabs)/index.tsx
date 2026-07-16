// OWNER: fe-dashboard — Dashboard: org greeting + parcel cards (latest NDVI, sparkline, alert badge).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';

import { api } from '@/api/client';
import type { Alert, IndexName, IndexPoint, LatestIndices, Org, Parcel, Role, User } from '@/api/types';
import { cropLabel, indexColor } from '@/features/insights/format';
import { colors, radius, spacing } from '@/theme';

type Me = { user: User; org: Org; role: Role };
type LatestBatch = Record<string, LatestIndices>;

export default function Dashboard() {
  const { t } = useTranslation();
  const router = useRouter();
  const qc = useQueryClient();
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

  const alertCounts: Record<string, number> = {};
  for (const a of openAlerts.data ?? []) {
    if (a.parcel_id) alertCounts[a.parcel_id] = (alertCounts[a.parcel_id] ?? 0) + 1;
  }

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await qc.invalidateQueries();
    setRefreshing(false);
  }, [qc]);

  const name = me.data?.user.full_name?.split(' ')[0] ?? '';

  const header = (
    <View style={styles.header}>
      <Text style={styles.org}>{me.data?.org.name ?? '—'}</Text>
      <Text style={styles.greeting}>
        {name ? t('dashboard.greeting', { name }) : t('dashboard.greeting_generic')}
      </Text>
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
    <View style={styles.root}>
      <FlatList
        data={parcels.data ?? []}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.content}
        ListHeaderComponent={header}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        renderItem={({ item }) => (
          <ParcelCard
            parcel={item}
            ndvi={latest.data?.[item.id]?.ndvi ?? null}
            alertCount={alertCounts[item.id] ?? 0}
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

function ParcelCard({
  parcel,
  ndvi,
  alertCount,
  onPress,
}: {
  parcel: Parcel;
  ndvi: IndexPoint | null;
  alertCount: number;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const crop = cropLabel(parcel.crop);
  return (
    <Pressable style={({ pressed }) => [styles.card, pressed && styles.cardPressed]} onPress={onPress}>
      <View style={styles.cardTop}>
        <View style={styles.cardInfo}>
          <Text style={styles.cardName} numberOfLines={1}>
            {parcel.name}
          </Text>
          <Text style={styles.cardMeta}>
            {[crop, `${parcel.area_ha.toFixed(2)} ha`].filter(Boolean).join(' · ')}
          </Text>
        </View>
        {alertCount > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{alertCount}</Text>
          </View>
        )}
      </View>

      <View style={styles.cardBottom}>
        <View style={styles.ndviWrap}>
          <View style={[styles.dot, { backgroundColor: indexColor('ndvi', ndvi?.mean) }]} />
          <View>
            <Text style={styles.ndviLabel}>{t('dashboard.ndvi')}</Text>
            <Text style={styles.ndviValue}>{ndvi ? ndvi.mean.toFixed(2) : '—'}</Text>
          </View>
        </View>
        <Sparkline parcelId={parcel.id} />
      </View>
    </Pressable>
  );
}

function Sparkline({ parcelId }: { parcelId: string }) {
  const { data } = useQuery({
    queryKey: ['indices', parcelId, 'ndvi', 'spark'],
    queryFn: () =>
      api.get<{ index: IndexName; series: IndexPoint[] }>(`/parcels/${parcelId}/indices?index=ndvi`),
    staleTime: 5 * 60 * 1000,
  });
  const vals = (data?.series ?? []).slice(-8).map((p) => p.mean);
  const W = 84;
  const H = 30;
  const pad = 3;
  if (vals.length < 2) return <View style={{ width: W, height: H }} />;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const points = vals
    .map((v, i) => {
      const x = pad + (i / (vals.length - 1)) * (W - 2 * pad);
      const y = pad + (1 - (v - min) / range) * (H - 2 * pad);
      return `${x},${y}`;
    })
    .join(' ');
  return (
    <Svg width={W} height={H}>
      <Polyline points={points} fill="none" stroke={indexColor('ndvi', vals[vals.length - 1])} strokeWidth={2} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, gap: spacing.md },
  content: { padding: spacing.md, gap: spacing.md, flexGrow: 1 },
  header: { marginBottom: spacing.xs },
  org: { fontSize: 22, fontWeight: '800', color: colors.text },
  greeting: { fontSize: 14, color: colors.textMuted, marginTop: 2 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.border },
  cardPressed: { opacity: 0.7 },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start' },
  cardInfo: { flex: 1 },
  cardName: { fontSize: 17, fontWeight: '700', color: colors.text },
  cardMeta: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  badge: { minWidth: 24, height: 24, borderRadius: 12, paddingHorizontal: 6, backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  cardBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.md },
  ndviWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 18, height: 18, borderRadius: 9 },
  ndviLabel: { fontSize: 11, color: colors.textMuted },
  ndviValue: { fontSize: 18, fontWeight: '700', color: colors.text },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xl },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  emptyBody: { fontSize: 14, color: colors.textMuted, textAlign: 'center' },
  cta: { backgroundColor: colors.primary, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.md, marginTop: spacing.sm },
  ctaText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  errorText: { color: colors.danger, fontSize: 14 },
});

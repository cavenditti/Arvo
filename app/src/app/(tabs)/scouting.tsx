// OWNER: fe-scouting — Scouting feed: offline sync status header + local observation feed + FAB.
import { useNetInfo } from '@react-native-community/netinfo';
import Ionicons from '@expo/vector-icons/Ionicons';
import { format } from 'date-fns';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useEffect, useMemo } from 'react';
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

import { API_URL } from '@/api/client';
import type { Observation } from '@/api/types';
import { useParcels } from '@/features/scouting/parcels';
import { useScouting, useSync } from '@/offline/hooks';
import { ensureStarted, sync } from '@/offline/queue';
import { colors, radius, spacing } from '@/theme';

export default function Screen() {
  const { t } = useTranslation();
  const router = useRouter();
  const net = useNetInfo();
  const offline = net.isConnected === false;
  const snap = useScouting();
  const { pendingCount, syncing, error, syncNow } = useSync();
  const parcelsQ = useParcels();

  const parcelNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of parcelsQ.data ?? []) map[p.id] = p.name;
    return map;
  }, [parcelsQ.data]);

  useEffect(() => {
    ensureStarted();
    void sync(); // bootstrap: pull org history on first mount
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          {syncing ? (
            <>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.headerText}>{t('scouting.syncing')}</Text>
            </>
          ) : pendingCount > 0 ? (
            <>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{pendingCount}</Text>
              </View>
              <Text style={styles.headerText}>{t('scouting.pending')}</Text>
            </>
          ) : (
            <>
              <Ionicons name="cloud-done-outline" size={18} color={colors.success} />
              <Text style={styles.headerText}>{t('scouting.all_synced')}</Text>
            </>
          )}
        </View>
        <Pressable
          onPress={syncNow}
          disabled={syncing || offline}
          style={[styles.syncBtn, (syncing || offline) && styles.syncBtnDisabled]}
        >
          <Ionicons name="sync" size={16} color="#fff" />
          <Text style={styles.syncBtnText}>{t('scouting.sync')}</Text>
        </Pressable>
      </View>

      {offline ? (
        <View style={styles.banner}>
          <Ionicons name="cloud-offline-outline" size={16} color="#fff" />
          <Text style={styles.bannerText}>{t('scouting.offline_banner')}</Text>
        </View>
      ) : error ? (
        <View style={[styles.banner, styles.bannerError]}>
          <Ionicons name="warning-outline" size={16} color="#fff" />
          <Text style={styles.bannerText}>{t('scouting.sync_error')}</Text>
        </View>
      ) : null}

      <FlatList
        data={snap.observations}
        keyExtractor={(o) => o.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={syncing} onRefresh={syncNow} tintColor={colors.primary} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="camera-outline" size={48} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>{t('scouting.empty_title')}</Text>
            <Text style={styles.emptyHint}>{t('scouting.empty_hint')}</Text>
          </View>
        }
        renderItem={({ item }) => (
          <ObservationCard
            obs={item}
            parcelName={item.parcel_id ? parcelNames[item.parcel_id] : undefined}
            pendingThumb={snap.photoThumbByObs[item.id]}
            pending={snap.outbox.includes(item.id) || Boolean(snap.photoThumbByObs[item.id])}
          />
        )}
      />

      <Pressable style={styles.fab} onPress={() => router.push('/observation/new')}>
        <Ionicons name="add" size={30} color="#fff" />
      </Pressable>
    </View>
  );
}

function ObservationCard({
  obs,
  parcelName,
  pendingThumb,
  pending,
}: {
  obs: Observation;
  parcelName?: string;
  pendingThumb?: string;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const thumbUri = obs.photos.length > 0 ? API_URL + obs.photos[0].path : pendingThumb;
  let when = '';
  try {
    when = format(new Date(obs.taken_at), 'd MMM · HH:mm');
  } catch {
    when = '';
  }
  return (
    <View style={styles.card}>
      {thumbUri ? (
        <Image source={{ uri: thumbUri }} style={styles.thumb} contentFit="cover" />
      ) : (
        <View style={[styles.thumb, styles.thumbEmpty]}>
          <Ionicons name="image-outline" size={22} color={colors.textMuted} />
        </View>
      )}
      <View style={styles.cardBody}>
        <View style={styles.cardTop}>
          <Text style={styles.parcel} numberOfLines={1}>
            {parcelName ?? t('scouting.no_parcel')}
          </Text>
          <Ionicons
            name={pending ? 'cloud-upload-outline' : 'cloud-done-outline'}
            size={16}
            color={pending ? colors.warning : colors.success}
          />
        </View>
        {obs.note ? (
          <Text style={styles.note} numberOfLines={2}>
            {obs.note}
          </Text>
        ) : null}
        <View style={styles.cardMeta}>
          {obs.tags.slice(0, 4).map((tag) => (
            <View key={tag} style={styles.chip}>
              <Text style={styles.chipText}>{t(`tags.${tag}`, tag)}</Text>
            </View>
          ))}
          {when ? <Text style={styles.when}>{when}</Text> : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  headerText: { color: colors.textMuted, fontSize: 14 },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    backgroundColor: colors.warning,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  syncBtnDisabled: { opacity: 0.5 },
  syncBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.textMuted,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  bannerError: { backgroundColor: colors.danger },
  bannerText: { color: '#fff', fontSize: 13, flexShrink: 1 },
  list: { padding: spacing.md, paddingBottom: 96, gap: spacing.sm, flexGrow: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: spacing.xl * 2, gap: spacing.sm },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  emptyHint: { fontSize: 14, color: colors.textMuted, textAlign: 'center', paddingHorizontal: spacing.xl },
  card: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  thumb: { width: 84, height: 84 },
  thumbEmpty: { backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  cardBody: { flex: 1, padding: spacing.sm, gap: 4 },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  parcel: { fontWeight: '700', color: colors.text, fontSize: 15, flexShrink: 1 },
  note: { color: colors.text, fontSize: 14, lineHeight: 19 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs, marginTop: 2 },
  chip: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  chipText: { fontSize: 12, color: colors.textMuted },
  when: { fontSize: 12, color: colors.textMuted, marginLeft: 'auto' },
  fab: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
});

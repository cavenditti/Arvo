// OWNER: capture-observe — the observations list, now a plain stack route (/scouting). It is
// reached from the dashboard and after-save moments; its labeled action starts a note directly.
// Native header carries the title, so sync state lives in a content row recast as reassurance
// ("Tutto salvato sul telefono") rather than a second header bar.
import Ionicons from '@expo/vector-icons/Ionicons';
import { format } from 'date-fns';
import { Image } from 'expo-image';
import { Stack, useRouter } from 'expo-router';
import { useEffect } from 'react';
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

import type { Observation } from '@/api/types';
import { useOnlineStatus } from '@/components/StaleBanner';
import { dfLocale } from '@/features/insights/format';
import { mediaUri, useMediaToken } from '@/features/media';
import { useParcelNames } from '@/features/parcels/names';
import { useScouting, useSync } from '@/offline/hooks';
import { ensureStarted, sync } from '@/offline/queue';
import { colors, fonts, radius, spacing, touch, type as typeScale } from '@/theme';

export default function Screen() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const online = useOnlineStatus();
  const snap = useScouting();
  const { pendingCount, syncing, error, syncNow } = useSync();
  const parcelNames = useParcelNames();

  useEffect(() => {
    ensureStarted();
    void sync(); // bootstrap: pull org history on first mount
  }, []);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: t('scouting.open_list') }} />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={snap.observations}
        keyExtractor={(o) => o.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={syncing} onRefresh={syncNow} tintColor={colors.primary} />
        }
        ListHeaderComponent={
          <SyncRow
            online={online}
            syncing={syncing}
            pendingCount={pendingCount}
            error={error}
            onSync={syncNow}
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="camera-outline" size={48} color={colors.textMuted} />
            <Text style={styles.emptyTitle} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('scouting.empty_title')}
            </Text>
            <Text style={styles.emptyHint} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('scouting.empty_hint')}
            </Text>
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

      <Pressable
        style={[styles.fab, { bottom: spacing.lg + insets.bottom }]}
        onPress={() => router.push('/observation/new?mode=note')}
        accessibilityRole="button"
        accessibilityLabel={t('menu.new_note')}
      >
        <Ionicons name="create-outline" size={20} color={colors.onPrimary} />
        <Text style={styles.fabText} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('menu.new_note')}
        </Text>
      </Pressable>
    </View>
  );
}

/** Sync state as reassurance, not alarm: what's on the phone is safe, the rest happens by itself. */
function SyncRow({
  online,
  syncing,
  pendingCount,
  error,
  onSync,
}: {
  online: boolean;
  syncing: boolean;
  pendingCount: number;
  error: string | null;
  onSync: () => void;
}) {
  const { t } = useTranslation();

  let caption: string | null = null;
  if (!online) caption = t('scouting.offline_banner');
  else if (error) caption = t('scouting.sync_error');
  else if (pendingCount > 0) caption = `${pendingCount} ${t('scouting.pending')}`;

  return (
    <View style={styles.syncRow}>
      <View style={styles.syncMain}>
        <View style={styles.syncLeft}>
          {syncing ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : pendingCount > 0 ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText} maxFontSizeMultiplier={typeScale.maxMult}>
                {pendingCount}
              </Text>
            </View>
          ) : (
            <Ionicons name="cloud-done-outline" size={18} color={colors.success} />
          )}
          <Text style={styles.syncText} maxFontSizeMultiplier={typeScale.maxMult}>
            {syncing
              ? t('scouting.syncing')
              : pendingCount > 0
                ? t('scouting.saved_on_phone')
                : t('scouting.all_synced')}
          </Text>
        </View>
        <Pressable
          onPress={onSync}
          disabled={syncing || !online}
          style={[styles.syncBtn, (syncing || !online) && styles.syncBtnDisabled]}
          accessibilityRole="button"
          accessibilityLabel={t('scouting.sync')}
          accessibilityState={{ disabled: syncing || !online }}
        >
          <Ionicons name="sync" size={16} color={colors.primary} />
          <Text style={styles.syncBtnText} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('scouting.sync')}
          </Text>
        </Pressable>
      </View>
      {caption ? (
        <Text style={styles.syncCaption} maxFontSizeMultiplier={typeScale.maxMult}>
          {caption}
        </Text>
      ) : null}
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
  const mediaToken = useMediaToken();
  const thumbUri =
    obs.photos.length > 0 ? mediaUri(obs.photos[0].path, mediaToken) : pendingThumb;
  let when = '';
  try {
    when = format(new Date(obs.taken_at), 'd MMM · HH:mm', { locale: dfLocale() });
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
          <Text style={styles.parcel} numberOfLines={1} maxFontSizeMultiplier={typeScale.maxMult}>
            {parcelName ?? t('scouting.no_parcel')}
          </Text>
          <Ionicons
            name={pending ? 'cloud-upload-outline' : 'cloud-done-outline'}
            size={16}
            color={pending ? colors.warning : colors.success}
          />
        </View>
        {obs.note ? (
          <Text style={styles.note} numberOfLines={2} maxFontSizeMultiplier={typeScale.maxMult}>
            {obs.note}
          </Text>
        ) : null}
        <View style={styles.cardMeta}>
          {obs.tags.slice(0, 4).map((tag) => (
            <View key={tag} style={styles.chip}>
              <Text style={styles.chipText} maxFontSizeMultiplier={typeScale.maxMult}>
                {t(`tags.${tag}`, tag)}
              </Text>
            </View>
          ))}
          {when ? (
            <Text style={styles.when} maxFontSizeMultiplier={typeScale.maxMult}>
              {when}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.md, paddingBottom: 120, gap: spacing.sm, flexGrow: 1 },
  syncRow: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  syncMain: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  syncLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  syncText: {
    color: colors.text,
    fontSize: typeScale.body,
    fontFamily: fonts.bodyMedium,
    flexShrink: 1,
  },
  syncCaption: { color: colors.textMuted, fontSize: typeScale.caption, fontFamily: fonts.body },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    backgroundColor: colors.warning,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.onPrimary, fontSize: typeScale.caption, fontFamily: fonts.bodyBold },
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    minHeight: touch.chip,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
  },
  syncBtnDisabled: { opacity: 0.5 },
  syncBtnText: { color: colors.primary, fontFamily: fonts.bodySemiBold, fontSize: typeScale.body },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing.xl * 2,
    gap: spacing.sm,
  },
  emptyTitle: { fontSize: typeScale.title, fontFamily: fonts.display, color: colors.text },
  emptyHint: {
    fontSize: typeScale.body,
    fontFamily: fonts.body,
    color: colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
  },
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
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  parcel: { fontFamily: fonts.display, color: colors.text, fontSize: 15, flexShrink: 1 },
  note: { color: colors.text, fontSize: typeScale.body, fontFamily: fonts.body, lineHeight: 19 },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: 2,
  },
  chip: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  chipText: { fontSize: typeScale.caption, fontFamily: fonts.body, color: colors.textMuted },
  when: {
    fontSize: typeScale.caption,
    fontFamily: fonts.mono,
    color: colors.textMuted,
    marginLeft: 'auto',
  },
  fab: {
    position: 'absolute',
    right: spacing.lg,
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  fabText: {
    color: colors.onPrimary,
    fontFamily: fonts.bodyBold,
    fontSize: typeScale.body,
  },
});

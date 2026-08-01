// OWNER: parcel-detail — Field detail: header + status voice from features/insights/status.ts
// (one story per field, same as the dashboard), mini-map, plain-language score hero, advanced
// index disclosure, weather panel + full-weather link, grouped alert events with batched
// actions, recent scouting, share-report via the system share sheet, edit form with a real
// date picker, and archive. docs/UX-REVAMP.md is the contract.
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { API_URL, api } from '@/api/client';
import {
  INDEX_NAMES,
  type Alert as AlertRow,
  type AlertState,
  type IndexName,
  type Meta,
} from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import AlertList from '@/components/AlertList';
import DateField from '@/components/DateField';
import IndexChart from '@/components/IndexChart';
import MapView from '@/components/MapView';
import { StaleBanner } from '@/components/StaleBanner';
import { showToast } from '@/components/Toast';
import { MonoLabel, MonoValue, Pill, StatusChip, TintCard } from '@/components/ui';
import WeatherPanel from '@/components/WeatherPanel';
import { CROP_OPTIONS, type CropKey, cropIcon, cropLabelKey, formatArea } from '@/features/parcels/crops';
import { confirmDestructive, notify } from '@/features/parcels/dialog';
import {
  useAdvisories,
  useAgro,
  useArchiveParcel,
  useFarms,
  useIndexSeries,
  useLatestIndices,
  useParcel,
  useParcelAlerts,
  useRefreshImagery,
  useRemoveParcelPhoto,
  useSetParcelPhoto,
  useUpdateParcel,
  useWeather,
} from '@/features/parcels/hooks';
import { useParcelObservations } from '@/features/scouting/byParcel';
import { arvoScore, arvoScoreDetail, dfLocale, scoreColor } from '@/features/insights/format';
import { countAlertEvents } from '@/features/insights/grouping';
import { deriveFieldStatus, trendFromSeries } from '@/features/insights/status';
import { mediaUri, useMediaToken } from '@/features/media';
import type { Status } from '@/theme';
import {
  colors,
  fonts,
  gradients,
  radius,
  spacing,
  statusColors,
  touch,
  type as typeScale,
} from '@/theme';

const DAY_MS = 86_400_000;
type BulkAction = 'ack' | 'snooze' | 'dismiss';

export default function ParcelDetailScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { role } = useAuth();

  const parcelQ = useParcel(id);
  const farmsQ = useFarms();
  const [index, setIndex] = useState<IndexName>('ndvi');
  const [showOverlay, setShowOverlay] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const seriesQ = useIndexSeries(id, index);
  // The status trend always reads the NDVI series (shared cache with seriesQ when index=ndvi)
  // so the chip/headline/trend never change with the advanced index switcher.
  const ndviQ = useIndexSeries(id, 'ndvi');
  const latestQ = useLatestIndices(id ? [id] : []);
  const metaQ = useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/meta') });
  const weatherQ = useWeather(id);
  const agroQ = useAgro(id);
  const advisoriesQ = useAdvisories(id);
  const alertsQ = useParcelAlerts(id);
  const observations = useParcelObservations(id);

  const update = useUpdateParcel(id);
  const archive = useArchiveParcel();
  const refresh = useRefreshImagery(id);
  const qc = useQueryClient();
  const mediaToken = useMediaToken();
  const setPhoto = useSetParcelPhoto();
  const removePhoto = useRemoveParcelPhoto();
  const [sharingReport, setSharingReport] = useState(false);

  // Batched alert actions, mirroring (tabs)/alerts.tsx: optimistic flip on this parcel's
  // list, Promise.all over the per-alert endpoints, ONE ['alerts'] invalidation per batch.
  const listKey = ['alerts', 'parcel', id] as const;
  const bulkAlerts = useMutation({
    mutationFn: ({ ids, action, days }: { ids: string[]; action: BulkAction; days?: number }) => {
      if (action === 'snooze') {
        const until = new Date(Date.now() + (days ?? 3) * DAY_MS).toISOString();
        return Promise.all(ids.map((aid) => api.post<AlertRow>(`/alerts/${aid}/snooze`, { until })));
      }
      return Promise.all(ids.map((aid) => api.post<AlertRow>(`/alerts/${aid}/${action}`)));
    },
    onMutate: async ({ ids, action }) => {
      await qc.cancelQueries({ queryKey: ['alerts'] });
      const previous = qc.getQueryData<AlertRow[]>(listKey);
      if (previous) {
        const marked = new Set(ids);
        const state: AlertState =
          action === 'ack' ? 'acked' : action === 'dismiss' ? 'dismissed' : 'snoozed';
        qc.setQueryData<AlertRow[]>(
          listKey,
          previous.map((a) => (marked.has(a.id) ? { ...a, state } : a)),
        );
      }
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(listKey, ctx.previous);
      showToast({ message: t('toast.error_retry'), kind: 'error' });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  });

  // Cover photo (FR-0-010b): pick → upload → invalidations refresh photo_path.
  async function pickCoverPhoto(from: 'camera' | 'library') {
    try {
      if (from === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) return;
        const res = await ImagePicker.launchCameraAsync({ quality: 0.6 });
        if (res.canceled || !res.assets[0]) return;
        await uploadCover(res.assets[0]);
      } else {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) return;
        const res = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsMultipleSelection: false,
          quality: 0.6,
        });
        if (res.canceled || !res.assets[0]) return;
        await uploadCover(res.assets[0]);
      }
    } catch {
      // picker unavailable (e.g. camera on web) — silently ignore
    }
  }

  async function uploadCover(a: ImagePicker.ImagePickerAsset) {
    try {
      await setPhoto.mutateAsync({
        parcelId: id,
        uri: a.uri,
        name: a.fileName ?? `field_${Date.now()}.jpg`,
        mime: a.mimeType ?? 'image/jpeg',
      });
    } catch {
      notify(t('parcel.photo_error_title'), t('parcel.photo_error_msg'));
    }
  }

  const parcel = parcelQ.data;

  // edit state
  const [editing, setEditing] = useState(false);
  const [eName, setEName] = useState('');
  const [eCrop, setECrop] = useState<CropKey | null>(null);
  const [eVariety, setEVariety] = useState('');
  const [eDate, setEDate] = useState<string | null>(null);
  const [editErr, setEditErr] = useState<string | null>(null);

  // Hydrate the form in the toggle handler, not an effect — a background refetch swapping
  // the parcel object identity must not clobber what the user is typing mid-edit.
  function toggleEditing() {
    if (!editing && parcel) {
      setEName(parcel.name);
      setECrop((parcel.crop as CropKey) ?? null);
      setEVariety(parcel.variety ?? '');
      setEDate(parcel.planting_date ?? null);
      setEditErr(null);
    }
    setEditing((v) => !v);
  }

  if (parcelQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (parcelQ.isError || !parcel) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('parcel.load_error')}
        </Text>
        <Pressable style={styles.retry} onPress={() => parcelQ.refetch()} accessibilityRole="button">
          <Text style={styles.primaryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('common.retry')}
          </Text>
        </Pressable>
      </View>
    );
  }

  const farmName = farmsQ.data?.find((f) => f.id === parcel.farm_id)?.name ?? '—';
  // Narrowed alias: TS control-flow narrowing from the guard above doesn't reach into the callbacks.
  const p = parcel;

  // ONE status voice (docs/UX-REVAMP.md): chip + headline + trend all derive from
  // status.ts, fed with score+coverage, the 7-day NDVI trend and OPEN alert events.
  const openAlerts = (alertsQ.data ?? []).filter((a) => a.state === 'open');
  const trend = trendFromSeries(
    (ndviQ.data?.series ?? []).map((pt) => ({ date: pt.observed_at, value: pt.mean })),
  );
  const scoreDetail = arvoScoreDetail(latestQ.data?.[id]);
  const fieldStatus = deriveFieldStatus({
    score: scoreDetail.score,
    trend,
    openAlertEvents: countAlertEvents(openAlerts),
    coverage: scoreDetail.coverage,
  });
  // theme Status uses 'healthy' where status.ts says 'ok'
  const chipStatus: Status = fieldStatus.level === 'ok' ? 'healthy' : fieldStatus.level;
  const score = arvoScore(latestQ.data?.[id]);

  // Drone capture (13-field EASA form) is a professional flow — agronomist/admin only.
  const canCapture = role === 'agronomist' || role === 'admin';

  // Index-raster overlay gate: backend build must serve imagery AND the selected index's latest
  // observation must be scene-backed (has scene_id). series is asc by time → last point is latest.
  const series = seriesQ.data?.series ?? [];
  const latestPoint = series.length > 0 ? series[series.length - 1] : undefined;
  // Tile URLs carry short-lived media tokens (session JWTs are rejected in query strings).
  const overlayAvailable =
    (metaQ.data?.features.imagery ?? false) && !!latestPoint?.scene_id && !!mediaToken;
  const overlayOn = overlayAvailable && showOverlay;
  const [bw, bs, be, bn] = p.bbox;
  const padX = (be - bw) * 0.3;
  const padY = (bn - bs) * 0.3;
  const overlay = overlayOn
    ? {
        urlTemplate: `${API_URL}/api/v1/tiles/${p.id}/${index}/{z}/{x}/{y}.png?token=${mediaToken}`,
        opacity: 0.85,
        bounds: [bw - padX, bs - padY, be + padX, bn + padY] as [number, number, number, number],
      }
    : undefined;

  function saveEdit() {
    setEditErr(null);
    if (!eName.trim()) return setEditErr(t('parcel.err_name'));
    update.mutate(
      {
        name: eName.trim(),
        crop: eCrop ?? undefined,
        variety: eVariety.trim() || undefined,
        planting_date: eDate ?? undefined,
      },
      {
        onSuccess: () => {
          setEditing(false);
          showToast({ message: t('toast.saved'), kind: 'success' });
        },
        // humanized: never surface a raw HTTP/exception message in the form
        onError: () => setEditErr(t('parcel.save_failed_retry')),
      },
    );
  }

  function onArchive() {
    confirmDestructive({
      title: t('parcel.archive_title'),
      message: t('parcel.archive_confirm', { name: p.name }),
      confirmLabel: t('parcel.archive'),
      cancelLabel: t('common.cancel'),
      onConfirm: () =>
        archive.mutate(p.id, {
          onSuccess: () => router.back(),
          onError: () => notify(t('parcel.archive'), t('parcel.save_failed_retry')),
        }),
    });
  }

  function onRefreshImagery() {
    refresh.mutate(undefined, {
      onSuccess: (r) =>
        notify(
          t('parcel.imagery_title'),
          t('parcel.imagery_result', {
            found: r.scenes_found,
            added: r.scenes_new,
            computed: r.computed,
          }),
        ),
      onError: () => notify(t('parcel.imagery_title'), t('toast.error_retry')),
    });
  }

  // Share the season report as a real PDF: download to cache with the short-lived media
  // token (SDK 57 File API), then hand the local file to the system share sheet.
  // Any failure → quiet toast + the old open-in-browser behaviour as fallback.
  async function shareReport() {
    if (!mediaToken) {
      notify(t('parcel.report'), t('parcel.report_error'));
      return;
    }
    const url = `${API_URL}/api/v1/reports/parcels/${p.id}/season?lang=${i18n.language}&token=${mediaToken}`;
    if (Platform.OS === 'web') {
      Linking.openURL(url).catch(() => notify(t('parcel.report'), t('parcel.report_error')));
      return;
    }
    setSharingReport(true);
    try {
      const target = new File(Paths.cache, `arvo-report-${p.id}.pdf`);
      if (target.exists) target.delete();
      const file = await File.downloadFileAsync(url, target);
      if (!(await Sharing.isAvailableAsync())) throw new Error('sharing_unavailable');
      await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf' });
    } catch {
      showToast({
        message: t('parcel.report_share_failed', {
          defaultValue: 'Non riesco a condividere il PDF. Lo apro nel browser.',
        }),
        kind: 'error',
      });
      Linking.openURL(url).catch(() => notify(t('parcel.report'), t('parcel.report_error')));
    } finally {
      setSharingReport(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: parcel.name }} />
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top + 44}
      >
        <ScrollView
          style={styles.root}
          contentContainerStyle={[styles.content, { paddingBottom: spacing.xl + insets.bottom }]}
        >
          {/* header */}
          <View style={styles.header}>
            {parcel.photo_path && mediaToken ? (
              <Image
                source={{ uri: mediaUri(parcel.photo_path, mediaToken) }}
                style={styles.cropBadge}
                contentFit="cover"
                accessibilityLabel={t('parcel.photo')}
              />
            ) : (
              <View style={styles.cropBadge}>
                <Ionicons name={cropIcon(parcel.crop)} size={22} color={colors.primary} />
              </View>
            )}
            <View style={styles.flex1}>
              <View style={styles.titleRow}>
                <Text style={styles.title} numberOfLines={1} maxFontSizeMultiplier={typeScale.maxMult}>
                  {parcel.name}
                </Text>
                <StatusChip status={chipStatus} label={t(fieldStatus.chipKey)} />
              </View>
              <Text style={styles.subtitle} maxFontSizeMultiplier={typeScale.maxMult}>
                {t(cropLabelKey(parcel.crop))} · {formatArea(parcel.area_ha)} · {farmName}
              </Text>
            </View>
            <Pressable
              onPress={toggleEditing}
              hitSlop={8}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel={editing ? t('common.cancel') : t('common.edit')}
            >
              <Ionicons name={editing ? 'close' : 'pencil'} size={20} color={colors.primary} />
            </Pressable>
          </View>

          {/* freshness: quiet pill, only when offline or stale (>10 min) */}
          <StaleBanner updatedAt={parcelQ.dataUpdatedAt || null} />

          {/* edit form */}
          {editing ? (
            <View style={styles.card}>
              <Text style={styles.fieldLabel} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('parcel.name')}
              </Text>
              <TextInput style={styles.input} value={eName} onChangeText={setEName} />
              <Text style={styles.fieldLabel} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('parcel.crop')}
              </Text>
              <View style={styles.chips}>
                {CROP_OPTIONS.map((c) => {
                  const active = eCrop === c.value;
                  return (
                    <Pressable
                      key={c.value}
                      style={[styles.chip, active && styles.chipActive]}
                      onPress={() => setECrop(active ? null : c.value)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                    >
                      <Ionicons name={c.icon} size={14} color={active ? '#fff' : colors.textMuted} />
                      <Text
                        style={[styles.chipTxt, active && styles.chipTxtActive]}
                        maxFontSizeMultiplier={typeScale.maxMult}
                      >
                        {t(c.labelKey)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.fieldLabel} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('parcel.variety')}
              </Text>
              <TextInput style={styles.input} value={eVariety} onChangeText={setEVariety} />
              <DateField label={t('parcel.planting_date')} value={eDate} onChange={setEDate} />
              <Text style={styles.fieldLabel} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('parcel.photo')}
              </Text>
              <View style={styles.chips}>
                <Pressable
                  style={[styles.chip, setPhoto.isPending && styles.disabled]}
                  onPress={() => pickCoverPhoto('camera')}
                  disabled={setPhoto.isPending}
                  accessibilityRole="button"
                >
                  <Ionicons name="camera" size={14} color={colors.textMuted} />
                  <Text style={styles.chipTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                    {t('parcel.photo_take')}
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.chip, setPhoto.isPending && styles.disabled]}
                  onPress={() => pickCoverPhoto('library')}
                  disabled={setPhoto.isPending}
                  accessibilityRole="button"
                >
                  <Ionicons name="images" size={14} color={colors.textMuted} />
                  <Text style={styles.chipTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                    {t('parcel.photo_pick')}
                  </Text>
                </Pressable>
                {parcel.photo_path ? (
                  <Pressable
                    style={[styles.chip, removePhoto.isPending && styles.disabled]}
                    onPress={() => removePhoto.mutate(id)}
                    disabled={removePhoto.isPending}
                    accessibilityRole="button"
                  >
                    <Ionicons name="trash" size={14} color={colors.textMuted} />
                    <Text style={styles.chipTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                      {t('parcel.photo_remove')}
                    </Text>
                  </Pressable>
                ) : null}
                {setPhoto.isPending || removePhoto.isPending ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : null}
              </View>
              {editErr ? (
                <Text style={styles.error} maxFontSizeMultiplier={typeScale.maxMult}>
                  {editErr}
                </Text>
              ) : null}
              <Pressable
                style={[styles.primaryBtn, update.isPending && styles.disabled]}
                onPress={saveEdit}
                disabled={update.isPending}
                accessibilityRole="button"
              >
                {update.isPending ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                    {t('common.save')}
                  </Text>
                )}
              </Pressable>
            </View>
          ) : null}

          {/* mini-map */}
          <View style={styles.mapBox}>
            <MapView
              parcels={[{ parcel }]}
              mode="view"
              focus={[parcel.centroid.lon, parcel.centroid.lat, 15]}
              overlay={overlay}
              height={220}
            />
          </View>

          {/* Plain-language summary — chip, headline and trend all speak with the one
              status voice (status.ts). Raw satellite numbers live in advanced details. */}
          {score ? (
            <View style={styles.section}>
              <View style={styles.heroRow}>
                <View style={[styles.heroScore, { borderColor: scoreColor(score.value) }]}>
                  <MonoValue size={40} style={styles.heroValue}>{score.value}</MonoValue>
                  <MonoLabel>{t('score.name')}</MonoLabel>
                  {fieldStatus.partial ? (
                    <View style={styles.partialPill}>
                      <Pill
                        label={t('status.partial')}
                        fg={statusColors.watch.fg}
                        bg={statusColors.watch.bg}
                      />
                    </View>
                  ) : null}
                </View>
                <View style={styles.heroSummary}>
                  <Text style={styles.conditionTitle} maxFontSizeMultiplier={typeScale.maxMult}>
                    {t(fieldStatus.headlineKey)}
                  </Text>
                  <Text style={styles.conditionBody} maxFontSizeMultiplier={typeScale.maxMult}>
                    {t('score.short_explanation')}
                  </Text>
                  <View style={styles.trendSummary}>
                    <Ionicons
                      name={
                        trend.direction === 'up'
                          ? 'trending-up'
                          : trend.direction === 'down'
                            ? 'trending-down'
                            : 'remove'
                      }
                      size={15}
                      color={trend.direction === 'down' ? colors.accent : colors.primary}
                    />
                    <Text style={styles.heroDeltaHint} maxFontSizeMultiplier={typeScale.maxMult}>
                      {t(trend.labelKey)}
                    </Text>
                  </View>
                </View>
              </View>
              <Text style={styles.scoreMethod} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('score.explanation')}
              </Text>
              <MonoLabel>
                {t('score.based_on', { count: score.signalCount })}
                {score.observedAt
                  ? ` · ${format(parseISO(score.observedAt), 'd MMM', { locale: dfLocale() })}`
                  : ''}
              </MonoLabel>
            </View>
          ) : null}

          {/* Advanced index chart + switcher, collapsed by default. */}
          <View style={styles.section}>
            <View style={styles.sectionHeadRow}>
              <View style={styles.flex1}>
                <Text style={styles.sectionTitle} maxFontSizeMultiplier={typeScale.maxMult}>
                  {t('indices.advanced')}
                </Text>
                <Text style={styles.advancedHint} maxFontSizeMultiplier={typeScale.maxMult}>
                  {t('score.explanation')}
                </Text>
              </View>
              <Pressable
                style={styles.advancedButton}
                onPress={() => setShowAdvanced((v) => !v)}
                accessibilityRole="button"
                accessibilityState={{ expanded: showAdvanced }}
              >
                <Text style={styles.refreshTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                  {t(showAdvanced ? 'indices.hide_advanced' : 'parcel.why_score')}
                </Text>
                <Ionicons
                  name={showAdvanced ? 'chevron-up' : 'chevron-down'}
                  size={16}
                  color={colors.primary}
                />
              </Pressable>
            </View>
            {showAdvanced ? <>
              <View style={styles.advancedActions}>
                <Pressable
                  style={styles.refreshBtn}
                  onPress={onRefreshImagery}
                  disabled={refresh.isPending}
                  accessibilityRole="button"
                >
                  {refresh.isPending ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <Ionicons name="refresh" size={16} color={colors.primary} />
                  )}
                  <Text style={styles.refreshTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                    {t('parcel.refresh_imagery')}
                  </Text>
                </Pressable>
              </View>
              <View style={styles.chips}>
                {INDEX_NAMES.map((ix) => {
                  const active = ix === index;
                  return (
                    <Pressable
                      key={ix}
                      style={[styles.indexChip, active && styles.chipActive]}
                      onPress={() => setIndex(ix)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                    >
                      {/* plain name first, acronym after (docs/DESIGN.md §14) */}
                      <Text
                        style={[styles.chipTxt, active && styles.chipTxtActive]}
                        maxFontSizeMultiplier={typeScale.maxMult}
                      >
                        {t(`index.${ix}.name`)} · {ix.toUpperCase()}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.indexDescription} maxFontSizeMultiplier={typeScale.maxMult}>
                {t(`index.${index}.description`)}
              </Text>
              {overlayAvailable ? (
                <View style={styles.chips}>
                  <Pressable
                    style={[styles.chip, overlayOn && styles.chipActive]}
                    onPress={() => setShowOverlay((v) => !v)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: overlayOn }}
                  >
                    <Ionicons name="layers" size={14} color={overlayOn ? '#fff' : colors.textMuted} />
                    <Text
                      style={[styles.chipTxt, overlayOn && styles.chipTxtActive]}
                      maxFontSizeMultiplier={typeScale.maxMult}
                    >
                      {t('parcel.overlay')}
                    </Text>
                  </Pressable>
                </View>
              ) : null}
              {seriesQ.isLoading ? (
                <ActivityIndicator color={colors.primary} style={styles.pad} />
              ) : (seriesQ.data?.series.length ?? 0) === 0 ? (
                <Text style={styles.muted} maxFontSizeMultiplier={typeScale.maxMult}>
                  {t('parcel.no_series')}
                </Text>
              ) : (
                <>
                  <IndexChart series={seriesQ.data?.series ?? []} index={index} />
                  {latestPoint ? (
                    <View style={styles.statRow}>
                      <StatTile label={t('stats.mean')} value={latestPoint.mean} />
                      <StatTile label={t('stats.p10')} value={latestPoint.p10} />
                      <StatTile label={t('stats.p90')} value={latestPoint.p90} />
                    </View>
                  ) : null}
                </>
              )}
            </> : null}
          </View>

          {/* weather + agronomy */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('parcel.weather')}
            </Text>
            {weatherQ.isLoading ? (
              <ActivityIndicator color={colors.primary} style={styles.pad} />
            ) : (
              <WeatherPanel
                daily={weatherQ.data?.daily ?? []}
                agro={agroQ.data}
                advisories={advisoriesQ.data}
              />
            )}
            <Pressable
              style={styles.fullWeatherBtn}
              onPress={() => router.push('/weather')}
              accessibilityRole="button"
              accessibilityLabel={t('parcel.weather_full', { defaultValue: 'Meteo completo' })}
            >
              <Ionicons name="partly-sunny-outline" size={18} color={colors.primary} />
              <Text style={styles.fullWeatherTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('parcel.weather_full', { defaultValue: 'Meteo completo' })}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={colors.primary} />
            </Pressable>
          </View>

          {/* alerts, grouped into events (features/insights/grouping.ts) */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('parcel.alerts')}
            </Text>
            {alertsQ.isLoading ? (
              <ActivityIndicator color={colors.primary} style={styles.pad} />
            ) : (alertsQ.data?.length ?? 0) === 0 ? (
              <Text style={styles.muted} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('parcel.no_alerts')}
              </Text>
            ) : (
              <AlertList
                alerts={alertsQ.data ?? []}
                parcelName={() => p.name}
                onConfirm={(ids) => bulkAlerts.mutate({ ids, action: 'ack' })}
                onSnooze={(ids, days) => bulkAlerts.mutate({ ids, action: 'snooze', days })}
                onDismiss={(ids) => bulkAlerts.mutate({ ids, action: 'dismiss' })}
              />
            )}
          </View>

          {/* recent scouting */}
          {observations.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('parcel.recent_scouting', { defaultValue: 'Recent scouting' })}
              </Text>
              {observations.slice(0, 3).map((o) => {
                const thumb = o.photos[0];
                const tag = o.tags[0];
                return (
                  <View key={o.id} style={styles.obsRow}>
                    {thumb ? (
                      <Image
                        source={{ uri: mediaUri(thumb.path, mediaToken) }}
                        style={styles.obsThumb}
                        contentFit="cover"
                      />
                    ) : (
                      <View style={[styles.obsThumb, styles.obsThumbEmpty]} />
                    )}
                    <View style={styles.flex1}>
                      <View style={styles.obsMetaRow}>
                        <MonoValue size={12} weight="700">
                          {format(parseISO(o.taken_at), 'd MMM', { locale: dfLocale() })}
                        </MonoValue>
                        {tag ? (
                          <Pill
                            label={t(`tags.${tag}`, { defaultValue: tag })}
                            fg={statusColors.watch.fg}
                            bg={statusColors.watch.bg}
                          />
                        ) : null}
                      </View>
                      <Text
                        style={styles.obsNote}
                        numberOfLines={2}
                        maxFontSizeMultiplier={typeScale.maxMult}
                      >
                        {o.note}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          ) : null}

          {/* record observation + report + archive */}
          <Pressable
            onPress={() =>
              router.push({ pathname: '/observation/new', params: { parcelId: p.id } })
            }
            accessibilityRole="button"
            accessibilityLabel={t('parcel.record_observation')}
          >
            <TintCard gradient={gradients.forest} style={styles.observeBtn}>
              <Ionicons name="add" size={20} color={colors.onPrimary} />
              <Text style={styles.observeTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('parcel.record_observation')}
              </Text>
            </TintCard>
          </Pressable>

          {/* per-plant tier (Phase P): plant map for everyone; the drone-flight EASA form
              only for professional roles — owners kept landing in a 13-field legal form. */}
          <View style={styles.plantRow}>
            <Pressable
              style={styles.plantBtn}
              onPress={() => router.push({ pathname: '/plants', params: { parcelId: p.id } })}
              accessibilityRole="button"
            >
              <Ionicons name="leaf-outline" size={18} color={colors.primary} />
              <Text style={styles.reportTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('plants.open_map')}
              </Text>
            </Pressable>
            {canCapture ? (
              <Pressable
                style={styles.plantBtn}
                onPress={() => router.push({ pathname: '/capture/new', params: { parcelId: p.id } })}
                accessibilityRole="button"
              >
                <Ionicons name="airplane-outline" size={18} color={colors.primary} />
                <Text style={styles.reportTxt} maxFontSizeMultiplier={typeScale.maxMult}>
                  {t('plants.empty_cta')}
                </Text>
              </Pressable>
            ) : null}
          </View>

          <Pressable
            style={[styles.reportBtn, sharingReport && styles.disabled]}
            onPress={shareReport}
            disabled={sharingReport}
            accessibilityRole="button"
            accessibilityLabel={t('parcel.report')}
          >
            {sharingReport ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Ionicons name="share-outline" size={18} color={colors.primary} />
            )}
            <Text style={styles.reportTxt} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('parcel.report')}
            </Text>
          </Pressable>

          <Pressable
            style={styles.archiveBtn}
            onPress={onArchive}
            disabled={archive.isPending}
            accessibilityRole="button"
          >
            <Ionicons name="archive" size={18} color={colors.danger} />
            <Text style={styles.archiveTxt} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('parcel.archive')}
            </Text>
          </Pressable>

          <Text style={styles.disclaimer} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('common.decision_support')}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

function StatTile({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <View style={styles.statTile}>
      {/* plain-language label wraps; the value stays mono (data voice) */}
      <Text style={styles.statLabel} maxFontSizeMultiplier={typeScale.maxMult}>
        {label}
      </Text>
      <MonoValue size={18} style={styles.statValue}>
        {value == null ? '—' : value.toFixed(2)}
      </MonoValue>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, backgroundColor: colors.bg },
  flex1: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  heroRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, flexWrap: 'wrap' },
  heroValue: { lineHeight: 48, letterSpacing: -1 },
  heroScore: {
    minWidth: 104,
    alignItems: 'center',
    padding: spacing.sm,
    borderWidth: 3,
    borderRadius: radius.lg,
    backgroundColor: colors.cardAlt,
  },
  partialPill: { marginTop: spacing.xs },
  heroSummary: { flex: 1, minWidth: 170, paddingBottom: spacing.xs },
  conditionTitle: { fontFamily: fonts.display, fontSize: 20, color: colors.text },
  conditionBody: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.textMuted, marginTop: 2 },
  trendSummary: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: spacing.xs },
  heroDeltaHint: { fontSize: typeScale.caption, fontFamily: fonts.bodyMedium, color: colors.textMuted },
  scoreMethod: { fontFamily: fonts.body, fontSize: 12, lineHeight: 17, color: colors.textMuted },
  statRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  statTile: {
    flex: 1,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    gap: 2,
  },
  statLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: typeScale.caption,
    lineHeight: 15,
    color: colors.textMuted,
  },
  statValue: { marginTop: 2 },
  observeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radius.lg,
    borderWidth: 0,
    paddingVertical: spacing.md,
    minHeight: 52,
  },
  observeTxt: { color: colors.onPrimary, fontFamily: fonts.bodyBold, fontSize: 16 },
  cropBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 21, fontFamily: fonts.display, color: colors.text, flexShrink: 1 },
  subtitle: { fontSize: 13, fontFamily: fonts.body, color: colors.textMuted, marginTop: 2 },
  iconBtn: { padding: spacing.sm, minWidth: touch.min, minHeight: touch.min, alignItems: 'center', justifyContent: 'center' },
  mapBox: { borderRadius: radius.md, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  section: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sectionHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { fontSize: 17, fontFamily: fonts.display, color: colors.text },
  advancedHint: { fontFamily: fonts.body, fontSize: 11.5, lineHeight: 16, color: colors.textMuted, marginTop: 2 },
  advancedButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: spacing.sm,
    minHeight: touch.chip,
    paddingHorizontal: spacing.xs,
  },
  advancedActions: { alignItems: 'flex-start', paddingTop: spacing.xs },
  indexDescription: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 18, color: colors.textMuted },
  obsRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', marginTop: spacing.xs },
  obsThumb: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: colors.cardAlt },
  obsThumbEmpty: { borderWidth: 1, borderColor: colors.borderSoft },
  obsMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  obsNote: { fontSize: 13, fontFamily: fonts.body, color: colors.textMuted, marginTop: 2, lineHeight: 18 },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fieldLabel: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.textMuted },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
    fontFamily: fonts.body,
    color: colors.text,
    backgroundColor: colors.bg,
    minHeight: touch.min,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: touch.chip,
  },
  indexChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: touch.chip,
    justifyContent: 'center',
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipTxt: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.text },
  chipTxtActive: { color: colors.onPrimary },
  refreshBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: touch.chip },
  refreshTxt: { color: colors.primary, fontSize: 13, fontFamily: fonts.bodySemiBold },
  muted: { color: colors.textMuted, fontFamily: fonts.body, fontSize: 14, paddingVertical: spacing.sm },
  pad: { paddingVertical: spacing.md },
  primaryBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touch.min,
  },
  primaryTxt: { color: colors.onPrimary, fontFamily: fonts.bodyBold, fontSize: 16 },
  retry: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    minHeight: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullWeatherBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: touch.min,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardAlt,
  },
  fullWeatherTxt: { color: colors.primary, fontFamily: fonts.bodySemiBold, fontSize: 15 },
  reportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    minHeight: touch.min,
  },
  plantRow: { flexDirection: 'row', gap: spacing.sm },
  plantBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    minHeight: touch.min,
  },
  reportTxt: { color: colors.primary, fontFamily: fonts.bodySemiBold, fontSize: 15 },
  archiveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    minHeight: touch.min,
  },
  archiveTxt: { color: colors.danger, fontFamily: fonts.bodySemiBold, fontSize: 15 },
  error: { color: colors.danger, fontFamily: fonts.bodyMedium, fontSize: 14 },
  disabled: { opacity: 0.5 },
  disclaimer: {
    color: colors.textFaint,
    fontFamily: fonts.body,
    fontSize: 11,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
});

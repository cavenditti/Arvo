// OWNER: fe-map — Parcel detail: header + mini-map, editable metadata, archive, NDVI/index chart
// with an index switcher, weather + agronomy panel, alerts, imagery refresh, and season report link.
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { API_URL, api, getAuthToken } from '@/api/client';
import { INDEX_NAMES, type IndexName, type Meta } from '@/api/types';
import AlertList from '@/components/AlertList';
import IndexChart from '@/components/IndexChart';
import MapView from '@/components/MapView';
import WeatherPanel from '@/components/WeatherPanel';
import {
  CROP_OPTIONS,
  type CropKey,
  cropIcon,
  cropLabelKey,
  formatArea,
  isValidDate,
} from '@/features/parcels/crops';
import {
  useAdvisories,
  useAgro,
  useAlertAction,
  useArchiveParcel,
  useFarms,
  useIndexSeries,
  useParcel,
  useParcelAlerts,
  useRefreshImagery,
  useUpdateParcel,
  useWeather,
} from '@/features/parcels/hooks';
import { confirmDestructive, notify } from '@/features/parcels/dialog';
import { colors, radius, spacing } from '@/theme';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function ParcelDetailScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const parcelQ = useParcel(id);
  const farmsQ = useFarms();
  const [index, setIndex] = useState<IndexName>('ndvi');
  const [showOverlay, setShowOverlay] = useState(false);
  const seriesQ = useIndexSeries(id, index);
  const metaQ = useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/meta') });
  const weatherQ = useWeather(id);
  const agroQ = useAgro(id);
  const advisoriesQ = useAdvisories(id);
  const alertsQ = useParcelAlerts(id);

  const update = useUpdateParcel(id);
  const archive = useArchiveParcel();
  const refresh = useRefreshImagery(id);
  const alertAction = useAlertAction(id);

  const parcel = parcelQ.data;

  // edit state
  const [editing, setEditing] = useState(false);
  const [eName, setEName] = useState('');
  const [eCrop, setECrop] = useState<CropKey | null>(null);
  const [eVariety, setEVariety] = useState('');
  const [eDate, setEDate] = useState('');
  const [editErr, setEditErr] = useState<string | null>(null);

  useEffect(() => {
    if (parcel && editing) {
      setEName(parcel.name);
      setECrop((parcel.crop as CropKey) ?? null);
      setEVariety(parcel.variety ?? '');
      setEDate(parcel.planting_date ?? '');
      setEditErr(null);
    }
  }, [editing, parcel]);

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
        <Text style={styles.muted}>{t('parcel.load_error')}</Text>
        <Pressable style={styles.retry} onPress={() => parcelQ.refetch()}>
          <Text style={styles.primaryTxt}>{t('common.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  const farmName = farmsQ.data?.find((f) => f.id === parcel.farm_id)?.name ?? '—';
  // Narrowed alias: TS control-flow narrowing from the guard above doesn't reach into the callbacks.
  const p = parcel;

  // Index-raster overlay gate: backend build must serve imagery AND the selected index's latest
  // observation must be scene-backed (has scene_id). series is asc by time → last point is latest.
  const series = seriesQ.data?.series ?? [];
  const latestPoint = series.length > 0 ? series[series.length - 1] : undefined;
  const overlayAvailable =
    (metaQ.data?.features.imagery ?? false) && !!latestPoint?.scene_id;
  const overlayOn = overlayAvailable && showOverlay;
  const [bw, bs, be, bn] = p.bbox;
  const padX = (be - bw) * 0.3;
  const padY = (bn - bs) * 0.3;
  const overlay = overlayOn
    ? {
        urlTemplate: `${API_URL}/api/v1/tiles/${p.id}/${index}/{z}/{x}/{y}.png?token=${getAuthToken()}`,
        opacity: 0.85,
        bounds: [bw - padX, bs - padY, be + padX, bn + padY] as [number, number, number, number],
      }
    : undefined;

  function saveEdit() {
    setEditErr(null);
    if (!eName.trim()) return setEditErr(t('parcel.err_name'));
    if (eDate.trim() && !isValidDate(eDate.trim())) return setEditErr(t('parcel.err_date'));
    update.mutate(
      {
        name: eName.trim(),
        crop: eCrop ?? undefined,
        variety: eVariety.trim() || undefined,
        planting_date: eDate.trim() || undefined,
      },
      { onSuccess: () => setEditing(false), onError: (e) => setEditErr(errMsg(e)) },
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
          onError: (e) => notify(t('parcel.archive'), errMsg(e)),
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
      onError: (e) => notify(t('parcel.imagery_title'), errMsg(e)),
    });
  }

  function openReport() {
    // NB: the report endpoint is auth-gated; this opens it in the system browser without the bearer
    // token (we never put secrets in URLs). Backend adds a share link in P1 — see final report notes.
    const url = `${API_URL}/api/v1/reports/parcels/${p.id}/season?lang=${i18n.language}`;
    Linking.openURL(url).catch(() => notify(t('parcel.report'), t('parcel.report_error')));
  }

  return (
    <>
      <Stack.Screen options={{ title: parcel.name }} />
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        {/* header */}
        <View style={styles.header}>
          <View style={styles.cropBadge}>
            <Ionicons name={cropIcon(parcel.crop)} size={22} color={colors.primary} />
          </View>
          <View style={styles.flex1}>
            <Text style={styles.title}>{parcel.name}</Text>
            <Text style={styles.subtitle}>
              {t(cropLabelKey(parcel.crop))} · {formatArea(parcel.area_ha)} · {farmName}
            </Text>
          </View>
          <Pressable onPress={() => setEditing((v) => !v)} hitSlop={8} style={styles.iconBtn}>
            <Ionicons name={editing ? 'close' : 'pencil'} size={20} color={colors.primary} />
          </Pressable>
        </View>

        {/* edit form */}
        {editing ? (
          <View style={styles.card}>
            <Text style={styles.fieldLabel}>{t('parcel.name')}</Text>
            <TextInput style={styles.input} value={eName} onChangeText={setEName} />
            <Text style={styles.fieldLabel}>{t('parcel.crop')}</Text>
            <View style={styles.chips}>
              {CROP_OPTIONS.map((c) => {
                const active = eCrop === c.value;
                return (
                  <Pressable
                    key={c.value}
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => setECrop(active ? null : c.value)}
                  >
                    <Ionicons name={c.icon} size={14} color={active ? '#fff' : colors.textMuted} />
                    <Text style={[styles.chipTxt, active && styles.chipTxtActive]}>{t(c.labelKey)}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.fieldLabel}>{t('parcel.variety')}</Text>
            <TextInput style={styles.input} value={eVariety} onChangeText={setEVariety} />
            <Text style={styles.fieldLabel}>{t('parcel.planting_date')}</Text>
            <TextInput
              style={styles.input}
              value={eDate}
              onChangeText={setEDate}
              placeholder="AAAA-MM-GG"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
            />
            {editErr ? <Text style={styles.error}>{editErr}</Text> : null}
            <Pressable style={[styles.primaryBtn, update.isPending && styles.disabled]} onPress={saveEdit} disabled={update.isPending}>
              {update.isPending ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryTxt}>{t('common.save')}</Text>}
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

        {/* index chart + switcher */}
        <View style={styles.section}>
          <View style={styles.sectionHeadRow}>
            <Text style={styles.sectionTitle}>{t('parcel.indices')}</Text>
            <Pressable style={styles.refreshBtn} onPress={onRefreshImagery} disabled={refresh.isPending}>
              {refresh.isPending ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Ionicons name="refresh" size={16} color={colors.primary} />
              )}
              <Text style={styles.refreshTxt}>{t('parcel.refresh_imagery')}</Text>
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
                >
                  <Text style={[styles.chipTxt, active && styles.chipTxtActive]}>{ix.toUpperCase()}</Text>
                </Pressable>
              );
            })}
          </View>
          {overlayAvailable ? (
            <View style={styles.chips}>
              <Pressable
                style={[styles.chip, overlayOn && styles.chipActive]}
                onPress={() => setShowOverlay((v) => !v)}
              >
                <Ionicons name="layers" size={14} color={overlayOn ? '#fff' : colors.textMuted} />
                <Text style={[styles.chipTxt, overlayOn && styles.chipTxtActive]}>
                  {t('parcel.overlay')}
                </Text>
              </Pressable>
            </View>
          ) : null}
          {seriesQ.isLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.pad} />
          ) : (seriesQ.data?.series.length ?? 0) === 0 ? (
            <Text style={styles.muted}>{t('parcel.no_series')}</Text>
          ) : (
            <IndexChart series={seriesQ.data?.series ?? []} index={index} />
          )}
        </View>

        {/* weather + agronomy */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('parcel.weather')}</Text>
          {weatherQ.isLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.pad} />
          ) : (
            <WeatherPanel
              daily={weatherQ.data?.daily ?? []}
              agro={agroQ.data}
              advisories={advisoriesQ.data}
            />
          )}
        </View>

        {/* alerts */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('parcel.alerts')}</Text>
          {alertsQ.isLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.pad} />
          ) : (alertsQ.data?.length ?? 0) === 0 ? (
            <Text style={styles.muted}>{t('parcel.no_alerts')}</Text>
          ) : (
            <AlertList
              alerts={alertsQ.data ?? []}
              parcelNames={{ [parcel.id]: parcel.name }}
              onAction={(alertId, action) => {
                const until =
                  action === 'snooze' ? new Date(Date.now() + 86400000).toISOString() : undefined;
                alertAction.mutate({ id: alertId, action, until });
              }}
            />
          )}
        </View>

        {/* report + archive */}
        <Pressable style={styles.reportBtn} onPress={openReport}>
          <Ionicons name="document-text" size={18} color={colors.primary} />
          <Text style={styles.reportTxt}>{t('parcel.report')}</Text>
          <Ionicons name="open-outline" size={16} color={colors.primary} />
        </Pressable>

        <Pressable style={styles.archiveBtn} onPress={onArchive} disabled={archive.isPending}>
          <Ionicons name="archive" size={18} color={colors.danger} />
          <Text style={styles.archiveTxt}>{t('parcel.archive')}</Text>
        </Pressable>

        <Text style={styles.disclaimer}>{t('common.decision_support')}</Text>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, backgroundColor: colors.bg },
  flex1: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cropBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#E6F0E6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  iconBtn: { padding: spacing.sm },
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
  sectionTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.bg,
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
  },
  indexChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipTxt: { fontSize: 13, color: colors.text },
  chipTxtActive: { color: '#fff', fontWeight: '600' },
  refreshBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  refreshTxt: { color: colors.primary, fontSize: 13, fontWeight: '600' },
  muted: { color: colors.textMuted, fontSize: 14, paddingVertical: spacing.sm },
  pad: { paddingVertical: spacing.md },
  primaryBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  primaryTxt: { color: '#fff', fontWeight: '700', fontSize: 16 },
  retry: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
  },
  reportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  reportTxt: { color: colors.primary, fontWeight: '600', fontSize: 15 },
  archiveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  archiveTxt: { color: colors.danger, fontWeight: '600', fontSize: 15 },
  error: { color: colors.danger, fontSize: 14 },
  disabled: { opacity: 0.5 },
  disclaimer: {
    color: colors.textMuted,
    fontSize: 11,
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: spacing.sm,
  },
});

// OWNER: web-parcel — Campo web portal parcel detail (mock screen 02). Wraps PortalShell directly
// (this route is outside the (tabs) group). Two-column layout: chart + stat tiles + scouting on the
// left, minimap + weather + alerts + manage on the right. Reuses the same hooks/patterns as the
// native parcel/[id].tsx screen. Theme tokens only.
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO, subDays } from 'date-fns';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { API_URL, api } from '@/api/client';
import { INDEX_NAMES, type IndexName, type Meta, type Observation } from '@/api/types';
import AlertList from '@/components/AlertList';
import IndexChart from '@/components/IndexChart';
import MapView from '@/components/MapView';
import { InteractivePressable, MonoLabel, MonoValue, Pill, StatusChip, TintCard } from '@/components/ui';
import FieldWorkspaceHeader from '@/components/web/FieldWorkspaceHeader';
import PortalShell from '@/components/web/PortalShell';
import WeatherPanel from '@/components/WeatherPanel';
import { confirmDestructive, notify } from '@/features/parcels/dialog';
import { CROP_OPTIONS, type CropKey, formatArea, isValidDate } from '@/features/parcels/crops';
import {
  useAdvisories,
  useAgro,
  useArchiveParcel,
  useIndexSeries,
  useLatestIndices,
  useParcel,
  useParcelAlerts,
  useRefreshImagery,
  useUpdateParcel,
  useWeather,
} from '@/features/parcels/hooks';
import { useParcelObservations } from '@/features/scouting/byParcel';
import { arvoScore, dfLocale, scoreBand, scoreColor, trendBand } from '@/features/insights/format';
import { worstOpenAlert } from '@/features/insights/alerts';
import { useAlertActions } from '@/features/insights/useAlertActions';
import { mediaUri, useMediaToken } from '@/features/media';
import { colors, fonts, gradients, radius, spacing, statusColors, statusForSeverity } from '@/theme';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmt2 = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(2));
type RailTab = 'weather' | 'alerts' | 'manage';

export default function ParcelDetailWeb() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const parcelQ = useParcel(id);
  const [index, setIndex] = useState<IndexName>('ndvi');
  const [showOverlay, setShowOverlay] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [railTab, setRailTab] = useState<RailTab>('weather');
  const seriesQ = useIndexSeries(id, index);
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
  const alertAction = useAlertActions(['alerts', 'parcel', id]);
  const mediaToken = useMediaToken();

  const parcel = parcelQ.data;

  // edit state (mirrors the native screen's inline form)
  const [editing, setEditing] = useState(false);
  const [eName, setEName] = useState('');
  const [eCrop, setECrop] = useState<CropKey | null>(null);
  const [eVariety, setEVariety] = useState('');
  const [eDate, setEDate] = useState('');
  const [editErr, setEditErr] = useState<string | null>(null);

  // Hydrate the form in the toggle handler, not an effect — a focus-triggered background
  // refetch must not clobber what the user is typing (web refetches on every tab switch).
  function toggleEditing() {
    if (!editing && parcel) {
      setEName(parcel.name);
      setECrop((parcel.crop as CropKey) ?? null);
      setEVariety(parcel.variety ?? '');
      setEDate(parcel.planting_date ?? '');
      setEditErr(null);
    }
    setEditing((v) => !v);
  }

  const locale = dfLocale();
  const series = seriesQ.data?.series ?? [];
  const latestPoint = series.length > 0 ? series[series.length - 1] : undefined;
  const score = arvoScore(latestQ.data?.[id]);
  const latestDelta = series.length > 1 && index === 'ndvi'
    ? latestPoint!.mean - series[series.length - 2].mean
    : null;
  const latestDate = latestPoint
    ? format(parseISO(latestPoint.observed_at), 'd MMM', { locale })
    : null;

  // last-90-day window of the selected index (all points if fewer)
  const last90 = (() => {
    if (!latestPoint) return series;
    const cutoff = subDays(parseISO(latestPoint.observed_at), 90).getTime();
    const sliced = series.filter((p) => parseISO(p.observed_at).getTime() >= cutoff);
    return sliced.length > 0 ? sliced : series;
  })();

  // Index-raster overlay gate (same rule as native): backend serves imagery AND the selected
  // index's latest observation is scene-backed AND a media token is available for tile URLs.
  const overlayAvailable =
    (metaQ.data?.features.imagery ?? false) && !!latestPoint?.scene_id && !!mediaToken;
  const overlayOn = overlayAvailable && showOverlay;

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

  function onArchive(name: string, pid: string) {
    confirmDestructive({
      title: t('parcel.archive_title'),
      message: t('parcel.archive_confirm', { name }),
      confirmLabel: t('parcel.archive'),
      cancelLabel: t('common.cancel'),
      onConfirm: () =>
        archive.mutate(pid, {
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
          t('parcel.imagery_result', { found: r.scenes_found, added: r.scenes_new, computed: r.computed }),
        ),
      onError: (e) => notify(t('parcel.imagery_title'), errMsg(e)),
    });
  }

  function openReport(pid: string) {
    // Opened in a new tab with a short-lived media token — never the session JWT.
    if (!mediaToken) {
      notify(t('parcel.report'), t('parcel.report_error'));
      return;
    }
    const url = `${API_URL}/api/v1/reports/parcels/${pid}/season?lang=${i18n.language}&token=${mediaToken}`;
    Linking.openURL(url).catch(() => notify(t('parcel.report'), t('parcel.report_error')));
  }

  let body: ReactNode;
  if (parcelQ.isLoading) {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  } else if (parcelQ.isError || !parcel) {
    body = (
      <View style={styles.center}>
        <Text style={styles.muted}>{t('parcel.load_error')}</Text>
        <InteractivePressable style={styles.retry} onPress={() => parcelQ.refetch()}>
          <Text style={styles.primaryTxt}>{t('common.retry')}</Text>
        </InteractivePressable>
      </View>
    );
  } else {
    const p = parcel;

    // worst open alert → parcel health status
    const worstOpen = worstOpenAlert(alertsQ.data ?? []);
    const status = statusForSeverity(worstOpen?.severity);

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

    const variance = latestPoint?.stddev != null ? latestPoint.stddev * latestPoint.stddev : null;
    const varianceHigh = (latestPoint?.stddev ?? 0) > 0.08;

    body = (
      <View style={styles.page}>
        <FieldWorkspaceHeader
          parcel={p}
          active="overview"
          actions={
            <>
              {latestDate ? (
                <View style={styles.dateChip}>
                  <MonoLabel color={colors.textMuted}>{latestDate}</MonoLabel>
                </View>
              ) : null}
              <InteractivePressable
                style={styles.outlineBtn}
                hoverStyle={styles.outlineBtnHover}
                onPress={() =>
                  router.push({ pathname: '/observation/new', params: { parcelId: p.id } })
                }
              >
                <Ionicons name="add" size={16} color={colors.primary} />
                <Text style={styles.outlineBtnTxt}>
                  {t('parcel.record_note', { defaultValue: 'Record note' })}
                </Text>
              </InteractivePressable>
              <InteractivePressable onPress={() => openReport(p.id)}>
                <TintCard gradient={gradients.forest} style={styles.exportBtn}>
                  <Ionicons name="document-text-outline" size={16} color={colors.onPrimary} />
                  <Text style={styles.exportBtnTxt}>
                    {t('parcel.export_report', { defaultValue: 'Export report' })}
                  </Text>
                </TintCard>
              </InteractivePressable>
            </>
          }
        />

        {/* two-column grid */}
        <View style={styles.grid}>
          {/* LEFT */}
          <ScrollView style={styles.colLeft} contentContainerStyle={styles.columnContent}>
            {/* score explanation + advanced chart, collapsed by default */}
            <View style={styles.card}>
              <View style={styles.conditionHead}>
                <View style={styles.conditionTitleRow}>
                  <Text style={styles.cardTitle}>{t('parcel.current_condition')}</Text>
                  <StatusChip status={status} label={t(`status.${status}`)} />
                </View>
                <View style={styles.conditionTools}>
                  {score ? (
                    <View style={styles.scoreSummary}>
                      <View style={[styles.scoreRing, { borderColor: scoreColor(score.value) }]}>
                        <MonoValue size={24}>{score.value}</MonoValue>
                      </View>
                      <View>
                        <MonoLabel>{t('score.name')}</MonoLabel>
                        <Text style={styles.scoreBand}>{t(`score.band.${scoreBand(score.value)}`)}</Text>
                        <Text style={styles.scoreTrend}>{t(`trend.${trendBand(latestDelta)}`)}</Text>
                      </View>
                    </View>
                  ) : null}
                  <InteractivePressable
                    style={styles.advancedButton}
                    hoverStyle={styles.softHover}
                    onPress={() => setShowAdvanced((v) => !v)}
                  >
                    <Ionicons name="options-outline" size={15} color={colors.primary} />
                    <Text style={styles.linkTxt}>
                      {t(showAdvanced ? 'indices.hide_advanced' : 'indices.advanced')}
                    </Text>
                    <Ionicons
                      name={showAdvanced ? 'chevron-up' : 'chevron-down'}
                      size={15}
                      color={colors.primary}
                    />
                  </InteractivePressable>
                </View>
              </View>
              <Text style={styles.scoreExplanation}>{t('score.explanation')}</Text>
              {score ? (
                <MonoLabel>{t('score.based_on', { count: score.signalCount })}</MonoLabel>
              ) : null}
              {showAdvanced ? (
                <>
                  <View style={styles.indexTabs}>
                    {INDEX_NAMES.map((ix) => {
                      const active = ix === index;
                      return (
                        <InteractivePressable
                          key={ix}
                          onPress={() => setIndex(ix)}
                          style={[styles.indexTab, active && styles.indexTabActive]}
                          hoverStyle={!active ? styles.controlHover : undefined}
                        >
                          <Text style={[styles.indexTabTxt, active && styles.indexTabTxtActive]}>
                            {t(`index.${ix}.name`)} · {ix.toUpperCase()}
                          </Text>
                        </InteractivePressable>
                      );
                    })}
                  </View>
                  <Text style={styles.indexDescription}>{t(`index.${index}.description`)}</Text>
                  <View style={styles.legend}>
                    <MonoLabel color={colors.primary}>
                      — {t('parcel.legend_mean', { defaultValue: 'field mean' })}
                    </MonoLabel>
                    <MonoLabel color={colors.textFaint}>p10–p90</MonoLabel>
                    <MonoLabel color={colors.textFaint}>
                      ○ {t('parcel.legend_cloud', { defaultValue: 'cloud-flagged' })}
                    </MonoLabel>
                  </View>
                  {seriesQ.isLoading ? (
                    <View style={[styles.chartLoading, { height: 320 }]}>
                      <ActivityIndicator color={colors.primary} />
                    </View>
                  ) : (
                    <IndexChart series={last90} index={index} height={320} />
                  )}
                </>
              ) : null}
            </View>

            {/* stat tiles */}
            {showAdvanced && latestPoint ? (
              <View style={styles.statsRow}>
                <StatTile label={t('parcel.stat_mean')} value={fmt2(latestPoint.mean)} />
                <StatTile label={t('parcel.stat_median', { defaultValue: 'Median' })} value={fmt2(latestPoint.median)} />
                <StatTile label={t('parcel.stat_p10')} value={fmt2(latestPoint.p10)} />
                <StatTile label={t('parcel.stat_p90')} value={fmt2(latestPoint.p90)} />
                <StatTile
                  label={t('parcel.stat_variance', { defaultValue: 'Variance' })}
                  value={variance == null ? '—' : variance.toFixed(3)}
                  color={varianceHigh ? colors.accent : colors.text}
                />
              </View>
            ) : null}

            {/* scouting observations */}
            <View style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>
                  {t('parcel.scouting_title', { defaultValue: 'Scouting observations' })}
                </Text>
                <InteractivePressable style={styles.inlineLink} hoverStyle={styles.softHover} onPress={() => router.push('/observation/new')}>
                  <Text style={styles.linkTxt}>{t('parcel.add_note', { defaultValue: 'Add note' })} +</Text>
                </InteractivePressable>
              </View>
              {observations.length === 0 ? (
                <Text style={styles.muted}>
                  {t('parcel.no_observations', { defaultValue: 'No scouting observations yet.' })}
                </Text>
              ) : (
                <View style={styles.obsList}>
                  {observations.map((o) => (
                    <ObsRow key={o.id} o={o} />
                  ))}
                </View>
              )}
            </View>
            <Text style={styles.disclaimer}>{t('common.decision_support')}</Text>
          </ScrollView>

          {/* RIGHT */}
          <View style={styles.colRight}>
            {/* minimap */}
            <View style={styles.mapCard}>
              <MapView
                parcels={[{ parcel: p }]}
                mode="view"
                focus={[p.centroid.lon, p.centroid.lat, 15]}
                overlay={overlay}
                height={220}
              />
              <View style={styles.mapChip}>
                <MonoLabel color={colors.text}>
                  {formatArea(p.area_ha)}
                  {latestDate ? ` · ${latestDate}` : ''}
                </MonoLabel>
              </View>
              {overlayAvailable ? (
                <InteractivePressable
                  style={[styles.overlayChip, overlayOn && styles.overlayChipOn]}
                  hoverStyle={!overlayOn ? styles.controlHover : undefined}
                  onPress={() => setShowOverlay((v) => !v)}
                >
                  <Ionicons name="layers" size={13} color={overlayOn ? colors.onPrimary : colors.primary} />
                  <Text style={[styles.overlayChipTxt, overlayOn && styles.overlayChipTxtOn]}>
                    {t('parcel.overlay')}
                  </Text>
                </InteractivePressable>
              ) : null}
            </View>

            <View style={styles.railTabs}>
              {(['weather', 'alerts', 'manage'] as RailTab[]).map((tab) => {
                const active = railTab === tab;
                const icon = tab === 'weather'
                  ? 'sunny-outline'
                  : tab === 'alerts'
                    ? 'warning-outline'
                    : 'settings-outline';
                return (
                  <InteractivePressable
                    key={tab}
                    style={[styles.railTab, active && styles.railTabActive]}
                    hoverStyle={!active ? styles.railTabHover : undefined}
                    onPress={() => setRailTab(tab)}
                  >
                    <Ionicons name={icon} size={14} color={active ? colors.onPrimary : colors.textMuted} />
                    <Text style={[styles.railTabText, active && styles.railTabTextActive]}>
                      {tab === 'manage'
                        ? t('parcel.manage', { defaultValue: 'Manage' })
                        : t(`parcel.${tab}`)}
                    </Text>
                  </InteractivePressable>
                );
              })}
            </View>

            <ScrollView style={styles.railScroll} contentContainerStyle={styles.railContent}>
              {railTab === 'weather' ? (
                <SectionCard title={t('parcel.weather')}>
                  {weatherQ.isLoading ? (
                    <ActivityIndicator color={colors.primary} style={styles.pad} />
                  ) : (
                    <WeatherPanel
                      daily={weatherQ.data?.daily ?? []}
                      agro={agroQ.data}
                      advisories={advisoriesQ.data}
                    />
                  )}
                </SectionCard>
              ) : null}

              {railTab === 'alerts' ? (
                <SectionCard title={t('parcel.alerts')}>
                  {alertsQ.isLoading ? (
                    <ActivityIndicator color={colors.primary} style={styles.pad} />
                  ) : (alertsQ.data?.length ?? 0) === 0 ? (
                    <Text style={styles.muted}>{t('parcel.no_alerts')}</Text>
                  ) : (
                    <AlertList
                      alerts={alertsQ.data ?? []}
                      parcelNames={{ [p.id]: p.name }}
                      onAction={(alertId, action) => alertAction.mutate({ id: alertId, action })}
                    />
                  )}
                </SectionCard>
              ) : null}

              {railTab === 'manage' ? (
                <SectionCard title={t('parcel.manage', { defaultValue: 'Manage' })}>
                  <View style={styles.manageBtns}>
                <InteractivePressable style={styles.manageBtn} hoverStyle={styles.manageBtnHover} onPress={onRefreshImagery} disabled={refresh.isPending}>
                  {refresh.isPending ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <Ionicons name="refresh" size={16} color={colors.primary} />
                  )}
                  <Text style={styles.manageBtnTxt}>{t('parcel.refresh_imagery')}</Text>
                </InteractivePressable>

                <InteractivePressable style={styles.manageBtn} hoverStyle={styles.manageBtnHover} onPress={toggleEditing}>
                  <Ionicons name={editing ? 'close' : 'pencil'} size={16} color={colors.primary} />
                  <Text style={styles.manageBtnTxt}>{t('parcel.edit_fields', { defaultValue: 'Edit fields' })}</Text>
                </InteractivePressable>

                {editing ? (
                  <View style={styles.editForm}>
                    <Text style={styles.fieldLabel}>{t('parcel.name')}</Text>
                    <TextInput style={styles.input} value={eName} onChangeText={setEName} />
                    <Text style={styles.fieldLabel}>{t('parcel.crop')}</Text>
                    <View style={styles.chips}>
                      {CROP_OPTIONS.map((c) => {
                        const active = eCrop === c.value;
                        return (
                          <InteractivePressable
                            key={c.value}
                            style={[styles.chip, active && styles.chipActive]}
                            hoverStyle={!active ? styles.controlHover : undefined}
                            onPress={() => setECrop(active ? null : c.value)}
                          >
                            <Ionicons name={c.icon} size={13} color={active ? colors.onPrimary : colors.textMuted} />
                            <Text style={[styles.chipTxt, active && styles.chipTxtActive]}>{t(c.labelKey)}</Text>
                          </InteractivePressable>
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
                      placeholder={t('parcel.date_placeholder')}
                      placeholderTextColor={colors.textFaint}
                      autoCapitalize="none"
                    />
                    {editErr ? <Text style={styles.error}>{editErr}</Text> : null}
                    <InteractivePressable
                      style={[styles.primaryBtn, update.isPending && styles.disabled]}
                      onPress={saveEdit}
                      disabled={update.isPending}
                    >
                      {update.isPending ? (
                        <ActivityIndicator color={colors.onPrimary} />
                      ) : (
                        <Text style={styles.primaryTxt}>{t('common.save')}</Text>
                      )}
                    </InteractivePressable>
                  </View>
                ) : null}

                <InteractivePressable
                  style={styles.manageBtn}
                  hoverStyle={styles.dangerHover}
                  onPress={() => onArchive(p.name, p.id)}
                  disabled={archive.isPending}
                >
                  <Ionicons name="archive-outline" size={16} color={colors.danger} />
                  <Text style={[styles.manageBtnTxt, styles.dangerTxt]}>{t('parcel.archive')}</Text>
                </InteractivePressable>
                  </View>
                </SectionCard>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <PortalShell>{body}</PortalShell>
    </>
  );
}

function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function StatTile({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.statTile}>
      <MonoLabel>{label}</MonoLabel>
      <MonoValue size={20} color={color} style={styles.statValue}>
        {value}
      </MonoValue>
    </View>
  );
}

function ObsRow({ o }: { o: Observation }) {
  const { t } = useTranslation();
  const locale = dfLocale();
  const mediaToken = useMediaToken();
  const thumb = o.photos[0];
  const tag = o.tags[0];
  return (
    <View style={styles.obsRow}>
      {thumb ? (
        <Image source={{ uri: mediaUri(thumb.path, mediaToken) }} style={styles.obsThumb} contentFit="cover" />
      ) : (
        <View style={[styles.obsThumb, styles.obsThumbEmpty]} />
      )}
      <View style={styles.flex1}>
        <View style={styles.obsMetaRow}>
          <MonoValue size={12} weight="700">
            {format(parseISO(o.taken_at), 'd MMM', { locale })}
          </MonoValue>
          {o.author_name ? <Text style={styles.obsAuthor}>{o.author_name}</Text> : null}
          {tag ? (
            <Pill label={t(`tags.${tag}`, { defaultValue: tag })} fg={statusColors.watch.fg} bg={statusColors.watch.bg} />
          ) : null}
        </View>
        <Text style={styles.obsNote} numberOfLines={2}>
          {o.note}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0, gap: spacing.md },
  center: { alignItems: 'center', justifyContent: 'center', gap: spacing.md, paddingVertical: spacing.xl * 3 },
  flex1: { flex: 1, minWidth: 0 },

  dateChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardAlt,
  },
  outlineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  outlineBtnTxt: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.primary },
  outlineBtnHover: { backgroundColor: colors.primarySoft, borderColor: colors.primaryDark },
  exportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 0,
  },
  exportBtnTxt: { fontSize: 13, fontFamily: fonts.bodyBold, color: colors.onPrimary },

  scoreSummary: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  scoreRing: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  scoreBand: { fontSize: 15, fontFamily: fonts.bodyBold, color: colors.text, marginTop: 2 },
  scoreTrend: { fontSize: 12, fontFamily: fonts.body, color: colors.textMuted, marginTop: 1 },
  indexTabs: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  indexTab: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  indexTabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  indexTabTxt: { fontSize: 12, fontFamily: fonts.monoSemiBold, color: colors.textMuted },
  indexTabTxtActive: { color: colors.onPrimary },

  // grid
  grid: { flex: 1, minHeight: 0, flexDirection: 'row', gap: spacing.lg, alignItems: 'stretch' },
  colLeft: { flex: 1.7, minWidth: 420, minHeight: 0 },
  columnContent: { gap: spacing.md, paddingBottom: spacing.sm },
  colRight: { flex: 1, minWidth: 300, minHeight: 0, gap: spacing.sm },

  // cards
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  cardTitle: { fontSize: 15, fontFamily: fonts.display, color: colors.text },
  linkTxt: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.primary },

  // chart
  conditionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  conditionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  conditionTools: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
    flexWrap: 'wrap',
  },
  scoreExplanation: {
    width: '100%',
    fontSize: 13,
    lineHeight: 19,
    fontFamily: fonts.body,
    color: colors.textMuted,
    marginTop: 3,
  },
  advancedButton: { flexDirection: 'row', alignItems: 'center', gap: 5, padding: spacing.sm },
  inlineLink: { padding: 4, borderRadius: radius.sm },
  indexDescription: { fontSize: 12.5, lineHeight: 18, fontFamily: fonts.body, color: colors.textMuted },
  legend: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' },
  chartLoading: { alignItems: 'center', justifyContent: 'center' },

  // stat tiles
  statsRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  statTile: {
    flexGrow: 1,
    flexBasis: 90,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: 2,
  },
  statValue: { marginTop: 2 },

  // scouting
  obsList: { gap: spacing.md },
  obsRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  obsThumb: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: colors.cardAlt },
  obsThumbEmpty: { borderWidth: 1, borderColor: colors.borderSoft },
  obsMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  obsAuthor: { fontSize: 12, fontFamily: fonts.bodyMedium, color: colors.textMuted },
  obsNote: { fontSize: 13, fontFamily: fonts.body, color: colors.textMuted, marginTop: 2, lineHeight: 18 },

  // minimap
  mapCard: {
    position: 'relative',
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  mapChip: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  overlayChip: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  overlayChipOn: { backgroundColor: colors.primary },
  overlayChipTxt: { fontSize: 12, fontFamily: fonts.bodySemiBold, color: colors.primary },
  overlayChipTxtOn: { color: colors.onPrimary },

  // contextual right rail
  railTabs: {
    flexDirection: 'row',
    gap: 4,
    padding: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  railTab: {
    flex: 1,
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  railTabActive: { backgroundColor: colors.primary },
  railTabHover: { backgroundColor: colors.cardAlt },
  railTabText: { fontSize: 12, fontFamily: fonts.bodySemiBold, color: colors.textMuted },
  railTabTextActive: { color: colors.onPrimary },
  railScroll: { flex: 1, minHeight: 0 },
  railContent: { paddingBottom: spacing.sm },

  // manage
  manageBtns: { gap: spacing.sm },
  manageBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardAlt,
  },
  manageBtnTxt: { fontSize: 14, fontFamily: fonts.bodySemiBold, color: colors.primary },
  manageBtnHover: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  dangerHover: { backgroundColor: statusColors.attention.bg, borderColor: colors.danger },
  dangerTxt: { color: colors.danger },
  // edit form
  editForm: { gap: spacing.sm, paddingVertical: spacing.xs },
  fieldLabel: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.textMuted },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 15,
    fontFamily: fonts.body,
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
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipTxt: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.text },
  chipTxtActive: { color: colors.onPrimary },

  // shared
  muted: { color: colors.textMuted, fontFamily: fonts.body, fontSize: 14, paddingVertical: spacing.xs },
  pad: { paddingVertical: spacing.md },
  primaryBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
  },
  primaryTxt: { color: colors.onPrimary, fontFamily: fonts.bodyBold, fontSize: 15 },
  retry: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
  },
  error: { color: colors.danger, fontFamily: fonts.bodyMedium, fontSize: 14 },
  disabled: { opacity: 0.5 },
  softHover: { backgroundColor: colors.cardAlt, borderRadius: radius.sm },
  controlHover: { backgroundColor: colors.cardAlt, borderColor: colors.primary },
  disclaimer: {
    color: colors.textFaint,
    fontFamily: fonts.body,
    fontSize: 11,
    marginTop: spacing.sm,
  },
});

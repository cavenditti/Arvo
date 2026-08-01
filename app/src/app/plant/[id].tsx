// OWNER: fe-plant-detail — Native per-plant detail (FR-P-052): identity + status hero, latest
// readings, the per-metric series and the canopy/height growth curve, this plant's flights, its
// scouting notes with photo thumbnails, its plant alerts, and the status lifecycle action.
// Keep in sync with [id].web.tsx — same data and helpers, portal layout there.
// Terra rules: no state dots, no left-border stripes, fonts are family tokens (never fontWeight).
import { useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import type { Locale } from 'date-fns';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import Svg, { Circle, G, Line, Path, Polyline, Rect, Text as SvgText } from 'react-native-svg';

import { ApiError, api } from '@/api/client';
import {
  INDEX_NAMES,
  PLANT_METRICS,
  type IndexName,
  type Observation,
  type Plant,
  type PlantAlert,
  type PlantCaptureEntry,
  type PlantLatestMetrics,
  type PlantMetric,
  type PlantObservation,
  type PlantSeriesResponse,
  type PlantStatus,
} from '@/api/types';
import { kindGlyph, type GlyphName } from '@/components/glyphs';
import {
  GlyphBadge,
  GlyphCard,
  InteractivePressable,
  MonoLabel,
  MonoValue,
  Pill,
  TintCard,
} from '@/components/ui';
import { INDEX_DOMAIN, dfLocale, indexColor } from '@/features/insights/format';
import { useAlertActions, type AlertAction } from '@/features/insights/useAlertActions';
import { mediaUri, useMediaToken } from '@/features/media';
import { confirmDestructive, notify } from '@/features/parcels/dialog';
import { useParcel } from '@/features/parcels/hooks';
import { usePlant } from '@/features/plants/hooks';
import { PHYSICAL_METRICS, metricLabelKey, plantName } from '@/features/plants/ranking';
import { useParcelObservations } from '@/features/scouting/byParcel';
import { formatDay, formatNumber, formatShortDay } from '@/lib/format';
import * as haptics from '@/lib/haptics';
import {
  alertStateTint,
  colors,
  fonts,
  gradients,
  radius,
  severityGradient,
  severityTint,
  spacing,
  statusColors,
  touch,
  type as typeScale,
} from '@/theme';

// Legal transitions, docs/API-PLANT.md §Plants (POST /plants/{id}/status). `removed` is terminal.
const TRANSITIONS: Record<PlantStatus, PlantStatus[]> = {
  alive: ['dead', 'missing', 'removed'],
  dead: ['replanted', 'alive', 'removed'],
  missing: ['replanted', 'alive', 'removed'],
  replanted: ['alive', 'dead', 'missing', 'removed'],
  removed: [],
};
const MARK_KEY: Record<PlantStatus, string> = {
  alive: 'plant.mark_alive',
  dead: 'plant.mark_dead',
  missing: 'plant.mark_missing',
  replanted: 'plant.mark_replanted',
  removed: 'plant.mark_removed',
};
// Metrics shown in the flight-history table (the rest live in the readings tiles).
const HISTORY_METRICS: PlantMetric[] = ['ndvi', 'canopy_m2', 'height_m'];

export default function PlantDetailScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const plantId = id ?? '';

  const [metric, setMetric] = useState<PlantMetric>('ndvi');
  const [growth, setGrowth] = useState<PlantMetric>('canopy_m2');
  const [note, setNote] = useState('');
  // Identity keeps the farmer's facts; codes, indices and coordinates wait behind this.
  const [techOpen, setTechOpen] = useState(false);

  const plantQ = usePlant(plantId);
  // The rest of docs/API-PLANT.md §Plant insights is fetched here rather than through
  // features/plants/hooks (fe-plant-map's file) — same documented query keys, so both
  // surfaces share the cache.
  const latestQ = useQuery({
    queryKey: ['plant-latest', plantId],
    queryFn: () => api.get<PlantLatestMetrics>(`/plants/${plantId}/metrics/latest`),
    enabled: !!plantId,
  });
  const seriesQ = useQuery({
    queryKey: ['plant-series', plantId, metric],
    queryFn: () => api.get<PlantSeriesResponse>(`/plants/${plantId}/series?metric=${metric}`),
    enabled: !!plantId,
  });
  const growthQ = useQuery({
    queryKey: ['plant-series', plantId, growth],
    queryFn: () => api.get<PlantSeriesResponse>(`/plants/${plantId}/series?metric=${growth}`),
    enabled: !!plantId,
  });
  const capturesQ = useQuery({
    queryKey: ['plant-captures', plantId],
    queryFn: () => api.get<PlantCaptureEntry[]>(`/plants/${plantId}/captures?limit=20`),
    enabled: !!plantId,
  });
  const alertsQ = useQuery({
    queryKey: ['alerts', 'plant', plantId],
    queryFn: () => api.get<PlantAlert[]>(`/plants/${plantId}/alerts?limit=50`),
    enabled: !!plantId,
  });

  const plant = plantQ.data;
  const parcelQ = useParcel(plant?.parcel_id ?? '');
  const alertAction = useAlertActions(['alerts', 'plant', plantId]);
  const mediaToken = useMediaToken();
  // Scouting lives in the offline store; a plant pin always carries its parcel (the server
  // fills parcel_id from the plant), so the parcel slice is the right place to look.
  const observations = useParcelObservations(plant?.parcel_id).filter((o) => o.plant_id === plantId);

  const qc = useQueryClient();
  const statusMut = useMutation({
    mutationFn: (input: { status: PlantStatus; note?: string }) =>
      api.post<Plant>(`/plants/${plantId}/status`, input),
    onSuccess: (updated) => {
      qc.setQueryData(['plant', plantId], updated);
      void qc.invalidateQueries({ queryKey: ['plants'] });
      void qc.invalidateQueries({ queryKey: ['plant-summary'] });
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      setNote('');
      haptics.success();
      notify(t('plant.status_change_title'), t('plant.status_saved'));
    },
    // humanized: the one legal-transition error gets its friendly copy, everything else the
    // generic retry line — never a raw server code.
    onError: (e) =>
      notify(
        t('plant.status_change_title'),
        e instanceof ApiError && e.code === 'bad_request'
          ? t('plant.status_illegal')
          : t('plant.status_error'),
      ),
  });

  const locale = dfLocale();

  if (plantQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (plantQ.isError || !plant) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>
          {plantQ.error instanceof ApiError && plantQ.error.status === 404
            ? t('plant.not_found')
            : t('plant.load_error')}
        </Text>
        <InteractivePressable
          style={styles.retry}
          accessibilityLabel={t('common.retry')}
          onPress={() => plantQ.refetch()}
        >
          <Text style={styles.primaryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('common.retry')}
          </Text>
        </InteractivePressable>
      </View>
    );
  }

  const p = plant;
  const name = plantName(p, t('plant.unlabeled'));
  const tone = statusTone(p.status);
  const latest = latestQ.data ?? {};
  const headline = headlineReading(latest);
  const captures = capturesQ.data ?? [];
  const alerts = alertsQ.data ?? [];
  const identityLine = [
    t(`plant.unit.${p.unit_type}`),
    p.variety,
    p.block_name,
    p.row_name,
  ]
    .filter(Boolean)
    .join(' · ');

  function askStatus(next: PlantStatus) {
    confirmDestructive({
      title: t('plant.status_change_title'),
      message: t('plant.status_change_confirm', { status: t(`plant.status.${next}`), plant: name }),
      confirmLabel: t(`plant.status.${next}`),
      cancelLabel: t('common.cancel'),
      onConfirm: () => statusMut.mutate({ status: next, note: note.trim() || undefined }),
    });
  }

  return (
    <>
      <Stack.Screen options={{ title: name }} />
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        {/* hero — the card IS the plant's condition (docs/DESIGN.md §5) */}
        <GlyphCard
          gradient={tone.grad}
          glyph={tone.glyph}
          glyphColor={tone.tone}
          glyphSize={140}
          style={styles.hero}
        >
          <View style={styles.heroTitleRow}>
            <Text style={styles.title} numberOfLines={2} maxFontSizeMultiplier={typeScale.maxMult}>
              {name}
            </Text>
            <Pill label={t(`plant.status.${p.status}`)} fg={tone.fg} bg={tone.bg} />
          </View>
          {identityLine ? (
            <Text style={styles.subtitle} maxFontSizeMultiplier={typeScale.maxMult}>
              {identityLine}
            </Text>
          ) : null}
          {headline ? (
            <View style={styles.heroReading}>
              <MonoValue size={38} style={styles.heroValue}>
                {formatMetric(headline.metric, headline.point.value)}
              </MonoValue>
              <View style={styles.heroReadingMeta}>
                <MonoLabel color={colors.textMuted}>
                  {t(metricLabelKey(headline.metric))}
                  {unitFor(headline.metric) ? ` · ${t(unitFor(headline.metric)!)}` : ''}
                </MonoLabel>
                <MonoLabel>
                  {format(parseISO(headline.point.observed_at), 'd MMM yyyy', { locale })}
                </MonoLabel>
              </View>
            </View>
          ) : (
            <Text style={styles.muted}>{t('plant.no_metrics')}</Text>
          )}
        </GlyphCard>

        {/* identity — the farmer's facts stay visible; codes, indices and coordinates live
            behind the "Dettagli tecnici" disclosure (docs/UX-REVAMP.md rule 7) */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('plant.identity')}
          </Text>
          <View style={styles.fields}>
            <Field label={t('plant.parcel')} value={parcelQ.data?.name} />
            <Field
              label={t('plant.planted_on')}
              value={p.planted_on ? formatDay(p.planted_on) : null}
            />
            <Field label={t('plant.variety')} value={p.variety} />
          </View>
          <InteractivePressable
            style={styles.linkRow}
            accessibilityLabel={`${t('plant.open_parcel')}${parcelQ.data ? ` ${parcelQ.data.name}` : ''}`}
            onPress={() => router.push(`/parcel/${p.parcel_id}`)}
          >
            <Ionicons name="map-outline" size={16} color={colors.primary} />
            <Text style={styles.linkTxt} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('plant.open_parcel')}
              {parcelQ.data ? ` · ${parcelQ.data.name}` : ''}
            </Text>
          </InteractivePressable>
          <InteractivePressable
            style={styles.disclosure}
            accessibilityState={{ expanded: techOpen }}
            accessibilityLabel={
              techOpen
                ? t('alerts_group.hide_detail', { defaultValue: 'Nascondi dettagli' })
                : t('alerts_group.show_detail')
            }
            onPress={() => setTechOpen((v) => !v)}
          >
            <Ionicons
              name={techOpen ? 'chevron-up' : 'chevron-down'}
              size={16}
              color={colors.textMuted}
            />
            <Text style={styles.disclosureLabel} maxFontSizeMultiplier={typeScale.maxMult}>
              {techOpen
                ? t('alerts_group.hide_detail', { defaultValue: 'Nascondi dettagli' })
                : t('alerts_group.show_detail')}
            </Text>
          </InteractivePressable>
          {techOpen ? (
            <View style={styles.fields}>
              <Field label={t('plant.unit_type')} value={t(`plant.unit.${p.unit_type}`)} />
              <Field label={t('plant.label')} value={p.label} />
              <Field label={t('plant.external_ref')} value={p.external_ref} mono />
              <Field label={t('plant.rootstock')} value={p.rootstock} />
              <Field label={t('plant.block')} value={p.block_name} />
              <Field label={t('plant.row')} value={p.row_name} />
              <Field label={t('plant.row_index')} value={numText(p.row_index)} mono />
              <Field label={t('plant.col_index')} value={numText(p.col_index)} mono />
              <Field label={t('plant.source_label')} value={t(`plant.source.${p.source}`)} />
              <Field
                label={t('plant.coordinates')}
                value={`${formatNumber(p.lat, { minimumFractionDigits: 5, maximumFractionDigits: 5 })}, ${formatNumber(p.lon, { minimumFractionDigits: 5, maximumFractionDigits: 5 })}`}
                mono
              />
              <Field label={t('plant.updated_at')} value={formatDay(p.updated_at)} />
            </View>
          ) : null}
        </View>

        {/* latest readings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('plant.latest_metrics')}
          </Text>
          {latestQ.isLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.pad} />
          ) : headline ? (
            <>
              <View style={styles.tiles}>
                {PLANT_METRICS.map((m) => {
                  const point = latest[m];
                  if (!point) return null;
                  return (
                    <View key={m} style={styles.tile}>
                      <MonoLabel>{t(metricLabelKey(m))}</MonoLabel>
                      <MonoValue size={18} style={styles.tileValue}>
                        {formatMetric(m, point.value)}
                        {unitFor(m) ? ` ${t(unitFor(m)!)}` : ''}
                      </MonoValue>
                      <MonoLabel>{format(parseISO(point.observed_at), 'd MMM', { locale })}</MonoLabel>
                    </View>
                  );
                })}
              </View>
              {headline.point.quality != null ? (
                // the naked "87%" becomes a sentence a farmer can trust at a glance
                <Text style={styles.hint} maxFontSizeMultiplier={typeScale.maxMult}>
                  {t('plant.quality_note', {
                    pct: headline.point.quality,
                    defaultValue: 'Affidabilità della misura: {{pct}}%',
                  })}
                </Text>
              ) : null}
            </>
          ) : (
            <Text style={styles.muted}>{t('plant.no_metrics')}</Text>
          )}
        </View>

        {/* per-metric series */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('plant.series')}
          </Text>
          <View style={styles.chips} accessibilityLabel={t('plant.select_metric')}>
            {INDEX_NAMES.map((m) => (
              <MetricChip
                key={m}
                label={t(metricLabelKey(m))}
                active={m === metric}
                onPress={() => setMetric(m)}
              />
            ))}
          </View>
          <Text style={styles.hint} maxFontSizeMultiplier={typeScale.maxMult}>
            {t(`index.${metric}.description`)}
          </Text>
          {seriesQ.isLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.pad} />
          ) : (
            <PlantChart series={seriesQ.data?.series ?? []} metric={metric} locale={locale} />
          )}
        </View>

        {/* canopy / height growth curve (FR-P-044) */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle} maxFontSizeMultiplier={typeScale.maxMult}>
            {t(metricLabelKey(growth))}
          </Text>
          <Text style={styles.hint} maxFontSizeMultiplier={typeScale.maxMult}>
            {t(`plant.metric_desc.${growth}`)}
          </Text>
          <View style={styles.chips}>
            {PHYSICAL_METRICS.map((m) => (
              <MetricChip
                key={m}
                label={t(metricLabelKey(m))}
                active={m === growth}
                onPress={() => setGrowth(m)}
              />
            ))}
          </View>
          {growthQ.isLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.pad} />
          ) : (
            <PlantChart series={growthQ.data?.series ?? []} metric={growth} locale={locale} />
          )}
        </View>

        {/* flight history */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('plant.history')}
          </Text>
          {capturesQ.isLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.pad} />
          ) : captures.length === 0 ? (
            <Text style={styles.muted}>{t('plant.no_history')}</Text>
          ) : (
            <>
              <View style={styles.tableHead}>
                <MonoLabel style={styles.colDate}>{t('plant.capture')}</MonoLabel>
                {HISTORY_METRICS.map((m) => (
                  <MonoLabel key={m} style={styles.colValue}>
                    {t(metricLabelKey(m))}
                  </MonoLabel>
                ))}
              </View>
              {captures.map((c) => (
                <View key={c.capture_id} style={styles.tableRow}>
                  <View style={styles.colDate}>
                    <MonoValue size={13}>
                      {format(parseISO(c.captured_at), 'd MMM yy', { locale })}
                    </MonoValue>
                    {c.quality != null ? (
                      <MonoLabel>{`${t('plant.quality')} ${c.quality}%`}</MonoLabel>
                    ) : null}
                  </View>
                  {HISTORY_METRICS.map((m) => (
                    <MonoValue key={m} size={13} weight="400" style={styles.colValue}>
                      {formatMetric(m, c.metrics[m])}
                    </MonoValue>
                  ))}
                </View>
              ))}
              {captures[0]?.model_ver ? (
                <MonoLabel>{`${t('plant.model_ver')} · ${captures[0].model_ver}`}</MonoLabel>
              ) : null}
            </>
          )}
        </View>

        {/* plant alerts — PlantAlert is per-plant, not an org Alert event, so these render as a
            small local card list in AlertList's visual language instead of going through
            groupAlerts (which would fold distinct plant signals into one event). */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('plant.alerts')}
          </Text>
          {alertsQ.isLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.pad} />
          ) : alerts.length === 0 ? (
            <Text style={styles.muted}>{t('plant.no_alerts')}</Text>
          ) : (
            <View style={styles.alertList}>
              {alerts.map((a) => (
                <PlantAlertCard
                  key={a.id}
                  alert={a}
                  onAction={(action) => alertAction.mutate({ id: a.id, action })}
                />
              ))}
            </View>
          )}
        </View>

        {/* scouting pinned to this plant */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('plant.scouting')}
          </Text>
          {observations.length === 0 ? (
            <Text style={styles.muted}>{t('plant.no_observations')}</Text>
          ) : (
            observations.map((o) => <ObsRow key={o.id} o={o} locale={locale} token={mediaToken} />)
          )}
        </View>

        <InteractivePressable
          accessibilityLabel={t('plant.add_note')}
          onPress={() =>
            router.push({
              pathname: '/observation/new',
              params: { parcelId: p.parcel_id, plantId: p.id },
            })
          }
        >
          <TintCard gradient={gradients.forest} style={styles.cta}>
            <Ionicons name="add" size={20} color={colors.onPrimary} />
            <Text style={styles.ctaTxt} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('plant.add_note')}
            </Text>
          </TintCard>
        </InteractivePressable>

        {/* status lifecycle */}
        {TRANSITIONS[p.status].length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('plant.actions')}
            </Text>
            <Text style={styles.fieldLabel} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('plant.status_note')}
            </Text>
            <TextInput
              style={styles.input}
              value={note}
              onChangeText={setNote}
              placeholder={t('plant.status_note_ph')}
              placeholderTextColor={colors.textFaint}
              accessibilityLabel={t('plant.status_note')}
              maxFontSizeMultiplier={typeScale.maxMult}
              multiline
            />
            {TRANSITIONS[p.status].map((next) => (
              <InteractivePressable
                key={next}
                style={styles.actionBtn}
                disabled={statusMut.isPending}
                accessibilityLabel={t(MARK_KEY[next])}
                accessibilityState={{ disabled: statusMut.isPending }}
                onPress={() => askStatus(next)}
              >
                <Ionicons
                  name={statusIcon(next)}
                  size={17}
                  color={next === 'removed' ? colors.danger : colors.primary}
                />
                <Text
                  style={[styles.actionTxt, next === 'removed' && styles.dangerTxt]}
                  maxFontSizeMultiplier={typeScale.maxMult}
                >
                  {t(MARK_KEY[next])}
                </Text>
              </InteractivePressable>
            ))}
          </View>
        ) : null}

        <Text style={styles.disclaimer} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('common.decision_support')}
        </Text>
      </ScrollView>
    </>
  );
}

// ── presentation helpers ─────────────────────────────────────────────────────

function MetricChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <InteractivePressable
      haptic
      style={[styles.chip, active && styles.chipActive]}
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
    >
      <Text style={[styles.chipTxt, active && styles.chipTxtActive]} maxFontSizeMultiplier={typeScale.maxMult}>
        {label}
      </Text>
    </InteractivePressable>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <View style={styles.field}>
      <MonoLabel>{label}</MonoLabel>
      {mono ? (
        <MonoValue size={13} weight="400" style={styles.fieldValue}>
          {value}
        </MonoValue>
      ) : (
        <Text style={styles.fieldValue} maxFontSizeMultiplier={typeScale.maxMult}>
          {value}
        </Text>
      )}
    </View>
  );
}

// ── per-plant alert cards ────────────────────────────────────────────────────
// PlantAlert ≠ org Alert event: one signal, one plant, acted on individually through the
// existing per-alert endpoints. Same visual language as components/AlertList (semantic
// gradient card, glyph badge, plain title first, ≥44pt actions) without the event grouping.

function PlantAlertCard({
  alert,
  onAction,
}: {
  alert: PlantAlert;
  onAction: (action: AlertAction) => void;
}) {
  const { t } = useTranslation();
  const sev = severityTint[alert.severity] ?? severityTint.info;
  const state = alertStateTint[alert.state] ?? alertStateTint.open;
  const actionable = alert.state === 'open' || alert.state === 'snoozed';
  return (
    <TintCard gradient={severityGradient(alert.severity)} style={styles.alertCard}>
      <View style={styles.alertHead}>
        <GlyphBadge glyph={kindGlyph(alert.kind)} fg={sev.fg} bg={sev.bg} size={28} />
        <Text style={styles.alertTitle} maxFontSizeMultiplier={typeScale.maxMult}>
          {t(`plant.alert.${alert.kind}`, { defaultValue: alert.title })}
        </Text>
        <Pill label={t(`severity.${alert.severity}`)} fg={sev.fg} bg={sev.bg} />
      </View>
      <MonoLabel style={styles.alertMeta}>
        {[alert.plant_label, formatShortDay(alert.created_at)].filter(Boolean).join(' · ')}
      </MonoLabel>
      <Text style={styles.alertBody} maxFontSizeMultiplier={typeScale.maxMult}>
        {alert.message}
      </Text>
      {actionable ? (
        <View style={styles.alertActions}>
          <PlantAlertButton
            primary
            label={t('alerts.ack')}
            onPress={() => {
              haptics.success();
              onAction('ack');
            }}
          />
          <PlantAlertButton label={t('alerts.snooze')} onPress={() => onAction('snooze')} />
          <PlantAlertButton label={t('alerts.dismiss')} onPress={() => onAction('dismiss')} />
        </View>
      ) : (
        <View style={styles.alertFooter}>
          <Pill label={t(`alerts.state.${alert.state}`)} fg={state.fg} bg={state.bg} />
        </View>
      )}
    </TintCard>
  );
}

function PlantAlertButton({
  label,
  onPress,
  primary,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  if (primary) {
    return (
      <InteractivePressable
        style={styles.alertBtnPrimaryWrap}
        accessibilityLabel={label}
        onPress={onPress}
      >
        <TintCard gradient={gradients.forest} style={styles.alertBtnPrimary}>
          <Text style={styles.alertBtnPrimaryTxt} maxFontSizeMultiplier={typeScale.maxMult}>
            {label}
          </Text>
        </TintCard>
      </InteractivePressable>
    );
  }
  return (
    <InteractivePressable style={styles.alertBtn} accessibilityLabel={label} onPress={onPress}>
      <Text style={styles.alertBtnTxt} maxFontSizeMultiplier={typeScale.maxMult}>
        {label}
      </Text>
    </InteractivePressable>
  );
}

function ObsRow({
  o,
  locale,
  token,
}: {
  o: Observation;
  locale: Locale;
  token: string | null;
}) {
  const { t } = useTranslation();
  const thumb = o.photos[0];
  const tag = o.tags[0];
  return (
    <View style={styles.obsRow}>
      {thumb ? (
        <Image
          source={{ uri: mediaUri(thumb.path, token) }}
          style={styles.obsThumb}
          contentFit="cover"
        />
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
            <Pill
              label={t(`tags.${tag}`, { defaultValue: tag })}
              fg={statusColors.watch.fg}
              bg={statusColors.watch.bg}
            />
          ) : null}
        </View>
        <Text style={styles.obsNote} numberOfLines={3}>
          {o.note}
        </Text>
      </View>
    </View>
  );
}

// ── per-plant series chart ───────────────────────────────────────────────────
// IndexChart's frozen contract takes IndexPoint[] (mean/p10/p90) + IndexName, which the
// per-plant series (single value, canopy_m2/height_m included) does not satisfy — so this
// draws the same visual language locally instead of widening the shared component.

const PAD = { top: 12, right: 12, bottom: 22, left: 34 };
const QUALITY_MIN = 50; // below this share of usable pixels the reading is drawn hollow

function PlantChart({
  series,
  metric,
  locale,
  height = 190,
}: {
  series: PlantObservation[];
  metric: PlantMetric;
  locale: Locale;
  height?: number;
}) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);

  if (series.length === 0) {
    return (
      <View style={[styles.chartEmpty, { height }]}>
        <Text style={styles.muted}>{t('plant.no_series')}</Text>
      </View>
    );
  }
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ height }}>
      {width > 0 ? (
        <ChartBody
          series={series}
          metric={metric}
          width={width}
          height={height}
          locale={locale}
          selected={selected}
          onSelect={setSelected}
        />
      ) : null}
    </View>
  );
}

function ChartBody({
  series,
  metric,
  width,
  height,
  locale,
  selected,
  onSelect,
}: {
  series: PlantObservation[];
  metric: PlantMetric;
  width: number;
  height: number;
  locale: Locale;
  selected: number | null;
  onSelect: (i: number | null) => void;
}) {
  const [yMin, yMax] = domainFor(metric, series);
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;

  const times = series.map((p) => parseISO(p.observed_at).getTime());
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const tRange = tMax - tMin;

  const xFor = (ms: number) => PAD.left + (tRange > 0 ? (ms - tMin) / tRange : 0.5) * innerW;
  const yFor = (v: number) => {
    const c = Math.max(yMin, Math.min(yMax, v));
    return PAD.top + (1 - (c - yMin) / (yMax - yMin)) * innerH;
  };

  const pts = series.map((p, i) => ({
    x: xFor(times[i]),
    y: yFor(p.value),
    low: (p.quality ?? 100) < QUALITY_MIN,
    p,
  }));
  const base = PAD.top + innerH;
  const area =
    `M ${pts[0].x} ${base} ` +
    pts.map((d) => `L ${d.x} ${d.y}`).join(' ') +
    ` L ${pts[pts.length - 1].x} ${base} Z`;
  const line = pts.map((d) => `${d.x},${d.y}`).join(' ');

  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4);
  const xTickIdx = [0, Math.floor((series.length - 1) / 2), series.length - 1].filter(
    (v, i, a) => a.indexOf(v) === i,
  );

  return (
    <Svg width={width} height={height}>
      {yTicks.map((v, i) => {
        const y = yFor(v);
        return (
          <G key={`y${i}`}>
            <Line x1={PAD.left} y1={y} x2={width - PAD.right} y2={y} stroke={colors.border} strokeWidth={1} />
            <SvgText
              x={PAD.left - 4}
              y={y + 3}
              fontSize={9}
              fontFamily={fonts.mono}
              fill={colors.textMuted}
              textAnchor="end"
            >
              {tickText(v)}
            </SvgText>
          </G>
        );
      })}

      <Path d={area} fill={colors.primary} fillOpacity={0.12} />
      <Polyline points={line} fill="none" stroke={colors.primary} strokeWidth={2} />

      {xTickIdx.map((i) => (
        <SvgText
          key={`x${i}`}
          x={Math.max(PAD.left + 12, Math.min(width - PAD.right - 12, pts[i].x))}
          y={height - 6}
          fontSize={9}
          fontFamily={fonts.mono}
          fill={colors.textMuted}
          textAnchor="middle"
        >
          {format(times[i], 'd MMM', { locale })}
        </SvgText>
      ))}

      {pts.map((d, i) => (
        <G key={`d${i}`}>
          <Circle
            cx={d.x}
            cy={d.y}
            r={3.5}
            fill={d.low ? colors.card : pointColor(metric, d.p.value)}
            stroke={colors.primary}
            strokeWidth={1.5}
          />
          {/* enlarged transparent hit target; rnsvg-web needs a DOM onClick — onPress would
              leak onResponder* props to the DOM and never fire (same as IndexChart) */}
          <Circle
            cx={d.x}
            cy={d.y}
            r={14}
            fill="transparent"
            {...(Platform.OS === 'web'
              ? ({ onClick: () => onSelect(selected === i ? null : i) } as object)
              : { onPress: () => onSelect(selected === i ? null : i) })}
          />
        </G>
      ))}

      {selected != null && pts[selected] ? (
        <ChartLabel
          text={`${formatMetric(metric, pts[selected].p.value)} · ${format(
            parseISO(pts[selected].p.observed_at),
            'd MMM',
            { locale },
          )}`}
          x={pts[selected].x}
          y={pts[selected].y}
          width={width}
        />
      ) : null}
    </Svg>
  );
}

function ChartLabel({ text, x, y, width }: { text: string; x: number; y: number; width: number }) {
  const boxW = 10 + text.length * 6;
  const boxH = 18;
  const bx = Math.max(4, Math.min(width - boxW - 4, x - boxW / 2));
  const by = Math.max(2, y - boxH - 6);
  return (
    <G>
      <Rect x={bx} y={by} width={boxW} height={boxH} rx={4} fill={colors.text} opacity={0.92} />
      <SvgText
        x={bx + boxW / 2}
        y={by + 12}
        fontSize={10}
        fontFamily={fonts.mono}
        fill="#FFFFFF"
        textAnchor="middle"
      >
        {text}
      </SvgText>
    </G>
  );
}

// ── pure helpers ─────────────────────────────────────────────────────────────

function isIndexMetric(m: PlantMetric): m is IndexName {
  return (INDEX_NAMES as string[]).includes(m);
}

/** i18n key of a metric's unit, or null for the unitless 0..1 indices. */
function unitFor(m: PlantMetric): string | null {
  return PHYSICAL_METRICS.includes(m) ? `plant.metric_unit.${m}` : null;
}

function formatMetric(m: PlantMetric, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const digits = m === 'canopy_m2' ? 1 : 2;
  // locale-aware ("0,82" in Italian) — docs/UX-REVAMP.md rule 7
  return formatNumber(v, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function numText(v: number | null | undefined): string | null {
  return v == null ? null : formatNumber(v);
}

function tickText(v: number): string {
  const abs = Math.abs(v);
  const digits = abs >= 10 || v % 1 === 0 ? 0 : 1;
  return formatNumber(v, { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/** Indices use their fixed domain; canopy/height are sizes → data-driven, zero-based. */
function domainFor(m: PlantMetric, series: PlantObservation[]): [number, number] {
  if (isIndexMetric(m)) return INDEX_DOMAIN[m];
  const values = series.map((p) => p.value).filter((v) => Number.isFinite(v));
  if (values.length === 0) return [0, 1];
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const span = max - min;
  return [min, max + (span > 0 ? span * 0.15 : Math.max(Math.abs(max) * 0.15, 0.5))];
}

function pointColor(m: PlantMetric, v: number): string {
  return isIndexMetric(m) ? indexColor(m, v) : colors.primary;
}

/** The reading the hero shows: vigor first, then whatever the flight could measure. */
function headlineReading(
  latest: PlantLatestMetrics,
): { metric: PlantMetric; point: PlantObservation } | null {
  for (const m of PLANT_METRICS) {
    const point = latest[m];
    if (point) return { metric: m, point };
  }
  return null;
}

/** Status → Terra tint + semantic backdrop + bleed glyph (no dots — docs/DESIGN.md §5). */
function statusTone(status: PlantStatus): {
  fg: string;
  bg: string;
  grad: [string, string];
  glyph: GlyphName;
  tone: string;
} {
  switch (status) {
    case 'alive':
      return { ...statusColors.healthy, grad: gradients.meadow, glyph: 'sprout', tone: colors.success };
    case 'replanted':
      return { ...severityTint.info, grad: gradients.eucalyptus, glyph: 'sprout', tone: colors.info };
    case 'missing':
      return { ...statusColors.watch, grad: gradients.straw, glyph: 'cloud', tone: colors.warning };
    case 'dead':
      return { ...statusColors.attention, grad: gradients.clay, glyph: 'leaf', tone: colors.accent };
    default:
      return {
        fg: colors.textFaint,
        bg: colors.borderSoft,
        grad: gradients.paper,
        glyph: 'cloud',
        tone: colors.textFaint,
      };
  }
}

function statusIcon(status: PlantStatus): keyof typeof Ionicons.glyphMap {
  if (status === 'alive') return 'leaf-outline';
  if (status === 'replanted') return 'refresh-outline';
  if (status === 'missing') return 'help-circle-outline';
  if (status === 'dead') return 'close-circle-outline';
  return 'trash-outline';
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    backgroundColor: colors.bg,
  },
  flex1: { flex: 1, minWidth: 0 },

  // hero
  hero: { borderRadius: radius.lg, padding: spacing.md, gap: 6 },
  heroTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  title: { flexShrink: 1, fontSize: 22, fontFamily: fonts.display, color: colors.text },
  subtitle: { fontSize: 13, fontFamily: fonts.body, color: colors.textMuted },
  heroReading: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, marginTop: spacing.xs },
  heroValue: { lineHeight: 44, letterSpacing: -1 },
  heroReadingMeta: { paddingBottom: 8, gap: 2 },

  // sections
  section: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sectionTitle: { fontSize: 17, fontFamily: fonts.display, color: colors.text },
  hint: { fontSize: 12.5, lineHeight: 18, fontFamily: fonts.body, color: colors.textMuted },

  // identity fields
  fields: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, rowGap: spacing.md },
  field: { flexGrow: 1, flexBasis: 130, gap: 2 },
  fieldValue: { fontSize: 14, fontFamily: fonts.body, color: colors.text },
  fieldLabel: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.textMuted },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: touch.chip,
    alignSelf: 'flex-start',
    paddingRight: spacing.sm,
  },
  linkTxt: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.primary },

  // "Dettagli tecnici" disclosure (same chevron pattern as AlertList)
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: touch.chip,
    alignSelf: 'flex-start',
    paddingRight: spacing.sm,
    borderRadius: radius.sm,
  },
  disclosureLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: typeScale.caption,
    color: colors.textMuted,
  },

  // reading tiles
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: {
    flexGrow: 1,
    flexBasis: 100,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: 2,
  },
  tileValue: { marginVertical: 1 },

  // chips (tappable — ≥40pt, docs/DESIGN.md §11)
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: touch.chip,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipTxt: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.text },
  chipTxtActive: { color: colors.onPrimary },

  // chart
  chartEmpty: { alignItems: 'center', justifyContent: 'center' },

  // flight history table
  tableHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  colDate: { flex: 1.4, gap: 2 },
  colValue: { flex: 1, textAlign: 'right' },

  // per-plant alert cards (AlertList's visual language, single-signal)
  alertList: { gap: spacing.sm },
  alertCard: {
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  alertHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  alertTitle: {
    flex: 1,
    fontFamily: fonts.display,
    fontSize: typeScale.bodyLg,
    lineHeight: 22,
    color: colors.text,
  },
  alertMeta: { marginTop: 6 },
  alertBody: {
    fontFamily: fonts.body,
    fontSize: typeScale.body,
    color: colors.textMuted,
    marginTop: 6,
    lineHeight: 20,
  },
  alertActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    paddingTop: spacing.sm,
  },
  alertFooter: { flexDirection: 'row', marginTop: spacing.sm },
  alertBtn: {
    flexGrow: 1,
    minHeight: touch.min,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  alertBtnTxt: { fontFamily: fonts.bodySemiBold, fontSize: typeScale.body, color: colors.primaryDark },
  alertBtnPrimaryWrap: { flexGrow: 1, borderRadius: radius.lg },
  alertBtnPrimary: {
    minHeight: touch.min,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    borderWidth: 0,
  },
  alertBtnPrimaryTxt: { fontFamily: fonts.bodyBold, fontSize: typeScale.body, color: colors.onPrimary },

  // scouting
  obsRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', marginTop: spacing.xs },
  obsThumb: { width: 48, height: 48, borderRadius: radius.sm, backgroundColor: colors.cardAlt },
  obsThumbEmpty: { borderWidth: 1, borderColor: colors.borderSoft },
  obsMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  obsAuthor: { fontSize: 12, fontFamily: fonts.bodyMedium, color: colors.textMuted },
  obsNote: { fontSize: 13, fontFamily: fonts.body, color: colors.textMuted, marginTop: 2, lineHeight: 18 },

  // actions
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radius.lg,
    borderWidth: 0,
    paddingVertical: spacing.md,
    minHeight: 52,
  },
  ctaTxt: { color: colors.onPrimary, fontFamily: fonts.bodyBold, fontSize: 16 },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardAlt,
    minHeight: touch.min + 4,
  },
  actionTxt: { fontSize: 15, fontFamily: fonts.bodySemiBold, color: colors.primary },
  dangerTxt: { color: colors.danger },
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
    minHeight: 56,
  },

  // shared
  muted: { color: colors.textMuted, fontFamily: fonts.body, fontSize: 14, paddingVertical: spacing.xs },
  pad: { paddingVertical: spacing.md },
  retry: {
    minHeight: touch.min,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
  },
  primaryTxt: { color: colors.onPrimary, fontFamily: fonts.bodyBold, fontSize: 16 },
  disclaimer: {
    color: colors.textFaint,
    fontFamily: fonts.body,
    fontSize: 11,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
});

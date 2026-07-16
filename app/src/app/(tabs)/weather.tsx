// OWNER: web-weather — Campo desktop portal "Weather" page (mock screen 04). One file for both
// platforms: desktop-first wrapping flex rows that degrade to stacked cards on narrow native
// screens. Hidden from the native tab bar (href:null in the tabs layout). Sections: 7-day
// forecast strip, three advisory cards, ET₀/water-balance grouped-bar chart, and a GDD card.
import { format, parseISO } from 'date-fns';
import type { Locale } from 'date-fns';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { G, Line, Rect, Text as SvgText } from 'react-native-svg';

import type { Advisory, AdvisoryKind, AgroSummary, Parcel, WeatherDaily } from '@/api/types';
import { Card, Dot, MonoLabel, MonoValue, Pill } from '@/components/ui';
import { useAdvisories, useAgro, useParcels, useWeather } from '@/features/parcels/hooks';
import { dfLocale } from '@/features/insights/format';
import { colors, fonts, radius, spacing, statusColors } from '@/theme';

const ADVISORY_KINDS: AdvisoryKind[] = ['frost_risk', 'heat_stress', 'spray_window'];

const KIND_LABEL: Record<AdvisoryKind, { key: string; def: string }> = {
  frost_risk: { key: 'weather.frost_risk', def: 'Frost risk' },
  heat_stress: { key: 'weather.heat_stress', def: 'Heat stress' },
  spray_window: { key: 'weather.spray_window', def: 'Field-work window' },
};

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtTemp(v: number | null | undefined): string {
  return v == null ? '—' : `${Math.round(v)}°`;
}

/** Condition dot color + legend bucket from precip/heat heuristics (no cloud field in the API). */
function condition(d: WeatherDaily): string {
  if ((d.precip_mm ?? 0) >= 1) return colors.info; // rain
  if ((d.t_max ?? 0) >= 30) return colors.warning; // clear / hot
  return colors.textFaint; // cloud
}

/** Coordinate label like "43.4°N 11.2°E" (1 decimal, hemisphere-aware). */
function coordLabel(lat: number, lon: number): string {
  const ns = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
  const ew = `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${ns} ${ew}`;
}

/** Latest advisory of a given kind (newest date wins). */
function latestByKind(advisories: Advisory[], kind: AdvisoryKind): Advisory | undefined {
  return advisories
    .filter((a) => a.kind === kind)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
}

/** Pill label + tint for an advisory (severity first, then kind), all from status tokens. */
function advisoryPill(a: Advisory): { key: string; def: string; fg: string; bg: string } {
  const { attention, watch, healthy } = statusColors;
  if (a.severity === 'critical') {
    return { key: 'weather.risk_high', def: 'High', fg: attention.fg, bg: attention.bg };
  }
  if (a.kind === 'heat_stress' || a.severity === 'warning') {
    return { key: 'weather.risk_elevated', def: 'Elevated', fg: watch.fg, bg: watch.bg };
  }
  if (a.kind === 'spray_window') {
    return { key: 'weather.risk_good', def: 'Good', fg: healthy.fg, bg: healthy.bg };
  }
  return { key: 'weather.risk_low', def: 'Low', fg: healthy.fg, bg: healthy.bg };
}

// ── screen ───────────────────────────────────────────────────────────────────

export default function WeatherScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const locale = dfLocale();

  const parcelsQ = useParcels();
  const parcelList = parcelsQ.data ?? [];

  const [pickedId, setPickedId] = useState<string | null>(null);
  const selectedId = pickedId ?? parcelList[0]?.id ?? null;
  const selected = parcelList.find((p) => p.id === selectedId) ?? null;

  // selection drives all three queries (disabled while no parcel is resolved)
  const weatherQ = useWeather(selectedId ?? '');
  const agroQ = useAgro(selectedId ?? '');
  const advisoriesQ = useAdvisories(selectedId ?? '');

  if (parcelsQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (parcelsQ.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{t('dashboard.load_error')}</Text>
        <Pressable style={styles.cta} onPress={() => parcelsQ.refetch()}>
          <Text style={styles.ctaText}>{t('common.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  if (parcelList.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.mutedLarge}>
          {t('weather.no_parcels', { defaultValue: 'No parcels yet' })}
        </Text>
      </View>
    );
  }

  const daily = weatherQ.data?.daily ?? [];
  const forecast = daily.filter((d) => d.is_forecast).slice(0, 7);
  const strip = forecast.length > 0 ? forecast : daily.slice(-7);
  const agro = agroQ.data;
  const advisories = advisoriesQ.data ?? [];

  return (
    <View style={styles.root}>
      {/* fixed header bar (matches the mock's 70px bar) */}
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <View style={styles.headerRow}>
          <View style={styles.flex1}>
            <Text style={styles.h1}>{t('weather.title', { defaultValue: 'Weather' })}</Text>
            {selected ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {`${selected.name} · ${coordLabel(selected.centroid.lat, selected.centroid.lon)}`}
              </Text>
            ) : null}
          </View>
          <ParcelSelector parcels={parcelList} selectedId={selectedId} onSelect={setPickedId} />
        </View>
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.content}>
        {/* 7-day forecast strip + legend */}
        <View>
          <Card style={styles.stripCard}>
            {strip.length > 0 ? (
              strip.map((d, i) => (
                <View key={d.date} style={[styles.dayCell, i === 0 && styles.dayCellFirst]}>
                  <MonoLabel size={11} color={colors.textFaint}>
                    {format(parseISO(d.date), 'EEE d', { locale })}
                  </MonoLabel>
                  <Dot color={condition(d)} size={22} />
                  <Text style={styles.tmax}>{fmtTemp(d.t_max)}</Text>
                  <Text style={styles.tmin}>{fmtTemp(d.t_min)}</Text>
                  <MonoValue size={10} weight="600" color={colors.info}>
                    {(d.precip_mm ?? 0) > 0 ? `${Math.round(d.precip_mm as number)} mm` : '–'}
                  </MonoValue>
                </View>
              ))
            ) : weatherQ.isLoading ? (
              <ActivityIndicator color={colors.primary} style={styles.stripLoading} />
            ) : (
              <Text style={styles.muted}>{t('weather.no_forecast')}</Text>
            )}
          </Card>
          <View style={styles.legend}>
            <LegendDot color={colors.warning} label={t('weather.cond_clear', { defaultValue: 'Clear' })} />
            <LegendDot color={colors.textFaint} label={t('weather.cond_cloud', { defaultValue: 'Cloud' })} />
            <LegendDot color={colors.info} label={t('weather.cond_rain', { defaultValue: 'Rain' })} />
          </View>
        </View>

        {/* advisory cards */}
        <View style={styles.cardRow}>
          {ADVISORY_KINDS.map((kind) => (
            <AdvisoryCard
              key={kind}
              kind={kind}
              advisory={latestByKind(advisories, kind)}
              locale={locale}
            />
          ))}
        </View>

        {/* ET₀ / water balance + GDD */}
        <View style={styles.cardRow}>
          <EtCard daily={daily} agro={agro} locale={locale} />
          <GddCard agro={agro} locale={locale} />
        </View>
      </ScrollView>
    </View>
  );
}

// ── parcel selector ────────────────────────────────────────────────────────

function ParcelSelector({
  parcels,
  selectedId,
  onSelect,
}: {
  parcels: Parcel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = parcels.find((p) => p.id === selectedId);
  return (
    <View style={styles.selectorWrap}>
      <Pressable
        style={styles.selectorChip}
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
      >
        <Text style={styles.selectorText} numberOfLines={1}>
          {selected?.name ?? '—'}
        </Text>
        <Text style={styles.selectorCaret}>▾</Text>
      </Pressable>
      {open ? (
        <View style={styles.dropdown}>
          {parcels.map((p) => (
            <Pressable
              key={p.id}
              style={({ pressed }) => [styles.dropItem, pressed && styles.dropItemPressed]}
              onPress={() => {
                onSelect(p.id);
                setOpen(false);
              }}
            >
              <Text
                style={[styles.dropText, p.id === selectedId && styles.dropTextActive]}
                numberOfLines={1}
              >
                {p.name}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ── advisory card ────────────────────────────────────────────────────────────

function AdvisoryCard({
  kind,
  advisory,
  locale,
}: {
  kind: AdvisoryKind;
  advisory: Advisory | undefined;
  locale: Locale;
}) {
  const { t } = useTranslation();
  const label = t(KIND_LABEL[kind].key, { defaultValue: KIND_LABEL[kind].def });

  if (!advisory) {
    return (
      <Card style={styles.advCard}>
        <View style={styles.advTop}>
          <MonoLabel size={10}>{label}</MonoLabel>
        </View>
        <Text style={styles.advHeadline}>—</Text>
        <Text style={styles.advMuted}>{t('weather.no_advisory', { defaultValue: 'No advisory' })}</Text>
      </Card>
    );
  }

  const pill = advisoryPill(advisory);
  const tinted = kind === 'heat_stress' && advisory.severity === 'warning';
  return (
    <Card style={[styles.advCard, tinted && { backgroundColor: statusColors.watch.bg }]}>
      <View style={styles.advTop}>
        <MonoLabel size={10}>{label}</MonoLabel>
        <Pill label={t(pill.key, { defaultValue: pill.def })} fg={pill.fg} bg={pill.bg} />
      </View>
      <Text style={styles.advHeadline}>
        {format(parseISO(advisory.date), 'EEE d MMM', { locale })}
      </Text>
      <Text style={styles.advBody}>{advisory.message}</Text>
    </Card>
  );
}

// ── ET₀ / water-balance card ───────────────────────────────────────────────

function EtCard({
  daily,
  agro,
  locale,
}: {
  daily: WeatherDaily[];
  agro: AgroSummary | undefined;
  locale: Locale;
}) {
  const { t } = useTranslation();
  const chartData = daily.slice(-14);
  const balanceNeg = agro != null && agro.water_balance_7d_mm < 0;

  return (
    <Card style={styles.etCard}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>
          {t('weather.et_title', { defaultValue: 'Evapotranspiration & water balance' })}
        </Text>
        <View style={styles.legendInline}>
          <LegendSquare color={colors.success} label={t('weather.et0', { defaultValue: 'ET₀' })} />
          <LegendSquare color={colors.info} label={t('weather.rain', { defaultValue: 'Rain' })} />
        </View>
      </View>

      {chartData.length > 0 ? (
        <EtChart data={chartData} locale={locale} />
      ) : (
        <Text style={styles.muted}>{t('chart.no_data')}</Text>
      )}

      {agro ? (
        <View style={styles.statRow}>
          <Stat value={`${Math.round(agro.et0_7d_mm)}`} label={t('weather.et0_7d')} />
          <Stat
            value={`${Math.round(agro.precip_7d_mm)}`}
            label={t('weather.precip_7d', { defaultValue: 'Rain 7d' })}
            color={colors.info}
          />
          <Stat
            value={`${Math.round(agro.water_balance_7d_mm)}`}
            label={t('weather.balance_7d')}
            color={balanceNeg ? colors.accent : colors.text}
          />
          {agro.notes.length > 0 ? (
            <View style={styles.noteChip}>
              <Text style={styles.noteChipText} numberOfLines={2}>
                {agro.notes[0]}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

/** Responsive grouped-bar chart: two thin bars per day (ET₀ success, rain info). */
function EtChart({ data, locale }: { data: WeatherDaily[]; locale: Locale }) {
  const [width, setWidth] = useState(0);
  const height = 172;
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ height, marginTop: spacing.sm }}>
      {width > 0 ? <EtBars data={data} width={width} height={height} locale={locale} /> : null}
    </View>
  );
}

function EtBars({
  data,
  width,
  height,
  locale,
}: {
  data: WeatherDaily[];
  width: number;
  height: number;
  locale: Locale;
}) {
  const PAD = { top: 10, right: 6, bottom: 22, left: 30 };
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const vals = data.flatMap((d) => [d.et0_mm ?? 0, d.precip_mm ?? 0]);
  const max = Math.max(1, ...vals);
  const slot = innerW / data.length;
  const barW = Math.max(2, Math.min(7, slot * 0.28));
  const yFor = (v: number) => PAD.top + (1 - v / max) * innerH;
  const ticks = [0, max / 2, max];

  return (
    <Svg width={width} height={height}>
      {ticks.map((v, i) => {
        const y = yFor(v);
        return (
          <G key={`t${i}`}>
            <Line x1={PAD.left} y1={y} x2={width - PAD.right} y2={y} stroke={colors.borderSoft} strokeWidth={1} />
            <SvgText
              x={PAD.left - 4}
              y={y + 3}
              fontSize={9}
              fontFamily={fonts.mono}
              fill={colors.textFaint}
              textAnchor="end"
            >
              {Math.round(v)}
            </SvgText>
          </G>
        );
      })}

      {data.map((d, i) => {
        const center = PAD.left + (i + 0.5) * slot;
        const et0H = ((d.et0_mm ?? 0) / max) * innerH;
        const prH = ((d.precip_mm ?? 0) / max) * innerH;
        return (
          <G key={`b${i}`}>
            <Rect
              x={center - barW - 1}
              y={PAD.top + innerH - et0H}
              width={barW}
              height={et0H}
              rx={1.5}
              fill={colors.success}
            />
            <Rect
              x={center + 1}
              y={PAD.top + innerH - prH}
              width={barW}
              height={prH}
              rx={1.5}
              fill={colors.info}
            />
          </G>
        );
      })}

      {data.map((d, i) =>
        i % 3 === 0 ? (
          <SvgText
            key={`x${i}`}
            x={PAD.left + (i + 0.5) * slot}
            y={height - 6}
            fontSize={9}
            fontFamily={fonts.mono}
            fill={colors.textFaint}
            textAnchor="middle"
          >
            {format(parseISO(d.date), 'd', { locale })}
          </SvgText>
        ) : null,
      )}
    </Svg>
  );
}

// ── GDD card ─────────────────────────────────────────────────────────────────

function GddCard({ agro, locale }: { agro: AgroSummary | undefined; locale: Locale }) {
  const { t } = useTranslation();

  if (!agro) {
    return (
      <Card style={styles.gddCard}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>
            {t('weather.gdd_title', { defaultValue: 'Growing degree days' })}
          </Text>
        </View>
        <Text style={styles.muted}>{t('chart.no_data')}</Text>
      </Card>
    );
  }

  const pct = Math.max(0, Math.min(1, agro.gdd.sum / 1000));
  const extraNotes = agro.notes.slice(1); // notes[0] is shown on the ET card

  return (
    <Card style={styles.gddCard}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>
          {t('weather.gdd_title', { defaultValue: 'Growing degree days' })}
        </Text>
        <MonoLabel size={10}>
          {t('weather.gdd_base', { defaultValue: 'Base {{temp}} °C', temp: agro.gdd.base_temp })}
        </MonoLabel>
      </View>

      <View style={styles.gddValueRow}>
        <MonoValue size={40} weight="500">
          {Math.round(agro.gdd.sum)}
        </MonoValue>
        <Text style={styles.gddUnit}>GDD</Text>
      </View>
      <Text style={styles.gddSince}>
        {t('weather.gdd_since', {
          defaultValue: 'Accumulated since {{date}}',
          date: format(parseISO(agro.gdd.from_date), 'd MMM yyyy', { locale }),
        })}
      </Text>

      <View style={styles.track}>
        <View style={[styles.fill, { width: `${pct * 100}%` }]} />
      </View>
      <View style={styles.scaleRow}>
        <MonoLabel size={9}>0</MonoLabel>
        <MonoLabel size={9}>1000</MonoLabel>
      </View>

      {extraNotes.length > 0 ? (
        <View style={styles.noteList}>
          {extraNotes.map((n, i) => (
            <View key={i} style={styles.noteRow}>
              <Dot color={colors.success} size={7} />
              <Text style={styles.noteText}>{n}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

// ── small pieces ─────────────────────────────────────────────────────────────

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <Dot color={color} size={9} />
      <MonoLabel size={10}>{label}</MonoLabel>
    </View>
  );
}

function LegendSquare({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendSquare, { backgroundColor: color }]} />
      <Text style={styles.legendSquareLabel}>{label}</Text>
    </View>
  );
}

function Stat({ value, label, color = colors.text }: { value: string; label: string; color?: string }) {
  return (
    <View style={styles.stat}>
      <MonoValue size={16} weight="500" color={color}>
        {value}
      </MonoValue>
      <MonoLabel size={9} style={styles.statLabel}>
        {label}
      </MonoLabel>
    </View>
  );
}

// ── styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    gap: spacing.md,
    padding: spacing.xl,
  },
  errorText: { color: colors.danger, fontSize: 14 },
  mutedLarge: { color: colors.textMuted, fontSize: 15 },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  ctaText: { color: colors.onPrimary, fontSize: 15, fontWeight: '700' },

  // header
  header: {
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    zIndex: 20,
    position: 'relative',
  },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  flex1: { flex: 1, minWidth: 0 },
  h1: { fontSize: 24, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
  subtitle: { fontSize: 13, color: colors.textMuted, marginTop: 3 },

  // parcel selector
  selectorWrap: { position: 'relative', zIndex: 30 },
  selectorChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 13,
    paddingVertical: 8,
    maxWidth: 240,
  },
  selectorText: { fontSize: 13, fontWeight: '600', color: colors.textMuted, flexShrink: 1 },
  selectorCaret: { fontSize: 12, color: colors.textFaint },
  dropdown: {
    position: 'absolute',
    top: 44,
    right: 0,
    minWidth: 190,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.xs,
    zIndex: 40,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  dropItem: { paddingHorizontal: spacing.md, paddingVertical: 9 },
  dropItemPressed: { backgroundColor: colors.cardAlt },
  dropText: { fontSize: 13, color: colors.text },
  dropTextActive: { color: colors.primary, fontWeight: '700' },

  // body
  body: { flex: 1, zIndex: 0 },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xl },
  cardRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },

  // forecast strip
  stripCard: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, padding: 6 },
  dayCell: {
    flexGrow: 1,
    flexBasis: 64,
    minWidth: 64,
    alignItems: 'center',
    gap: 6,
    paddingVertical: 14,
    paddingHorizontal: 6,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  dayCellFirst: { backgroundColor: colors.cardAlt, borderColor: colors.border },
  tmax: { fontSize: 18, fontWeight: '700', color: colors.text },
  tmin: { fontSize: 13, color: colors.textFaint },
  stripLoading: { marginVertical: spacing.lg, marginHorizontal: 'auto' },
  legend: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm, paddingLeft: spacing.xs },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendSquare: { width: 10, height: 10, borderRadius: 2 },
  legendSquareLabel: { fontSize: 11, color: colors.textMuted },

  // advisory cards
  advCard: { flexGrow: 1, flexBasis: 220, minWidth: 200, gap: spacing.sm },
  advTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  advHeadline: { fontSize: 16, fontWeight: '700', color: colors.text, letterSpacing: -0.2 },
  advBody: { fontSize: 13, color: colors.textMuted, lineHeight: 19 },
  advMuted: { fontSize: 13, color: colors.textFaint },

  // ET card
  etCard: { flexGrow: 1.5, flexBasis: 360, minWidth: 300 },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  cardTitle: { fontSize: 14, fontWeight: '700', color: colors.text, flexShrink: 1 },
  legendInline: { flexDirection: 'row', gap: spacing.md },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  stat: { flexDirection: 'row', alignItems: 'baseline' },
  statLabel: { marginLeft: 5 },
  noteChip: {
    marginLeft: 'auto',
    maxWidth: 260,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  noteChipText: { fontSize: 11.5, color: colors.primary },

  // GDD card
  gddCard: { flexGrow: 1, flexBasis: 240, minWidth: 220 },
  gddValueRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, marginTop: spacing.xs },
  gddUnit: { fontSize: 12, color: colors.textMuted, paddingBottom: 5 },
  gddSince: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginBottom: spacing.md },
  track: {
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.cardAlt,
    overflow: 'hidden',
  },
  fill: { height: '100%', backgroundColor: colors.success, borderRadius: 6 },
  scaleRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs },
  noteList: { gap: spacing.sm, marginTop: spacing.md },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  noteText: { fontSize: 12, color: colors.textMuted, flex: 1 },

  // shared
  muted: { color: colors.textMuted, padding: spacing.md },
});

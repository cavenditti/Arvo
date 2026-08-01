// OWNER: web-weather — Campo desktop portal "Weather" page (mock screen 04), Terra design language
// (docs/DESIGN.md). One file for both platforms: desktop-first wrapping flex rows that degrade to
// stacked cards on narrow native screens. Hidden from the native tab bar (href:null in the tabs
// layout). Sections: illustrated 7-day forecast strip, three advisory glyph cards, ET₀/water-balance
// grouped-bar chart, and a GDD growth card. Condition & severity are painted by semantic gradients +
// bleed glyphs — never bare dots (docs/DESIGN.md §5).
import { format, parseISO } from 'date-fns';
import type { Locale } from 'date-fns';
import { Stack } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { G, Line, Rect, Text as SvgText } from 'react-native-svg';

import type { AdvisoryKind, AgroSummary, Parcel, WeatherDaily } from '@/api/types';
import { kindGlyph, weatherGlyph, weatherTone } from '@/components/glyphs';
import { Card, GlyphCard, InteractivePressable, MonoLabel, MonoValue, Pill, TintCard } from '@/components/ui';
import { useOutsideDismiss } from '@/components/useOutsideDismiss';
import { useAdvisories, useAgro, useParcels, useWeather } from '@/features/parcels/hooks';
import { dfLocale } from '@/features/insights/format';
import { advisoryCopy, mergeAdvisoryRuns, type AdvisoryRun } from '@/features/weather/merge';
import { formatNumber, formatShortDay } from '@/lib/format';
import {
  colors,
  fonts,
  gradients,
  radius,
  severityGradient,
  spacing,
  statusColors,
  type as typeScale,
  weatherGradient,
} from '@/theme';

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

/** Deeper tone of a severity backdrop (clay→accent, straw→warning, eucalyptus→info). */
function severityGlyphTone(severity?: string | null): string {
  if (severity === 'critical') return colors.accent;
  if (severity === 'warning') return colors.warning;
  return colors.info;
}

/** Latest merged run of a given kind (newest end date wins). Consecutive same-kind days
 * arrive already collapsed by mergeAdvisoryRuns — one card per event, never per day. */
function latestRunByKind(runs: AdvisoryRun[], kind: AdvisoryKind): AdvisoryRun | undefined {
  return runs.filter((r) => r.kind === kind).sort((a, b) => b.to.localeCompare(a.to))[0];
}

/** Pill label + tint for an advisory run (severity first, then kind), from status tokens. */
function advisoryPill(kind: string, severity: string): { key: string; def: string; fg: string; bg: string } {
  const { attention, watch, healthy } = statusColors;
  if (severity === 'critical') {
    return { key: 'weather.risk_high', def: 'High', fg: attention.fg, bg: attention.bg };
  }
  if (kind === 'heat_stress' || severity === 'warning') {
    return { key: 'weather.risk_elevated', def: 'Elevated', fg: watch.fg, bg: watch.bg };
  }
  if (kind === 'spray_window') {
    return { key: 'weather.risk_good', def: 'Good', fg: healthy.fg, bg: healthy.bg };
  }
  return { key: 'weather.risk_low', def: 'Low', fg: healthy.fg, bg: healthy.bg };
}

// ── screen ───────────────────────────────────────────────────────────────────

export default function WeatherScreen() {
  const { t } = useTranslation();
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
        <InteractivePressable style={styles.cta} onPress={() => parcelsQ.refetch()}>
          <Text style={styles.ctaText}>{t('common.retry')}</Text>
        </InteractivePressable>
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
  // consecutive same-kind days collapse into single events (features/weather/merge.ts)
  const advisoryRuns = mergeAdvisoryRuns(advisoriesQ.data);

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: t('weather.title', { defaultValue: 'Weather' }) }} />
      <ScrollView
        style={styles.body}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
      >
        <View style={styles.headerRow}>
          <Text style={styles.subtitle} numberOfLines={1} maxFontSizeMultiplier={typeScale.maxMult}>
            {selected?.name ?? '—'}
          </Text>
          <ParcelSelector parcels={parcelList} selectedId={selectedId} onSelect={setPickedId} />
        </View>
        {/* illustrated 7-day forecast strip */}
        {strip.length > 0 ? (
          <View style={styles.stripRow}>
            {strip.map((d, i) => {
              const glyph = weatherGlyph(d.t_min, d.t_max, d.precip_mm);
              return (
                <GlyphCard
                  key={d.date}
                  gradient={weatherGradient(d.t_min, d.t_max, d.precip_mm)}
                  glyph={glyph}
                  glyphColor={weatherTone(glyph)}
                  glyphOpacity={0.18}
                  glyphSize={140}
                  style={[styles.dayCell, i === 0 && styles.dayCellToday]}
                >
                  <View style={styles.dayInner}>
                    <MonoLabel size={11} color={colors.textFaint}>
                      {format(parseISO(d.date), 'EEE d', { locale })}
                    </MonoLabel>
                    <MonoValue size={20} weight="600">
                      {fmtTemp(d.t_max)}
                    </MonoValue>
                    <MonoValue size={13} weight="400" color={colors.textMuted}>
                      {fmtTemp(d.t_min)}
                    </MonoValue>
                    <MonoValue size={10} weight="600" color={colors.info}>
                      {(d.precip_mm ?? 0) > 0 ? `${Math.round(d.precip_mm as number)} mm` : '–'}
                    </MonoValue>
                  </View>
                </GlyphCard>
              );
            })}
          </View>
        ) : weatherQ.isLoading ? (
          <Card style={styles.stripPlaceholder}>
            <ActivityIndicator color={colors.primary} />
          </Card>
        ) : (
          <Card style={styles.stripPlaceholder}>
            <Text style={styles.muted}>{t('weather.no_forecast')}</Text>
          </Card>
        )}

        {/* advisory cards — one per kind, fed with the latest merged run */}
        <View style={styles.cardRow}>
          {ADVISORY_KINDS.map((kind) => (
            <AdvisoryCard key={kind} kind={kind} run={latestRunByKind(advisoryRuns, kind)} />
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
  const selectorRef = useRef<View | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideDismiss(selectorRef, open, close);
  const selected = parcels.find((p) => p.id === selectedId);
  return (
    <View ref={selectorRef} style={styles.selectorWrap}>
      <InteractivePressable
        style={styles.selectorChip}
        hoverStyle={styles.selectorHover}
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.selectorText} numberOfLines={1}>
          {selected?.name ?? '—'}
        </Text>
        <Text style={styles.selectorCaret}>{open ? '▴' : '▾'}</Text>
      </InteractivePressable>
      {open ? (
        <View style={styles.dropdown}>
          {parcels.map((p) => (
            <InteractivePressable
              key={p.id}
              style={styles.dropItem}
              hoverStyle={styles.dropItemPressed}
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
            </InteractivePressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ── advisory card ────────────────────────────────────────────────────────────

function AdvisoryCard({ kind, run }: { kind: AdvisoryKind; run: AdvisoryRun | undefined }) {
  const { t } = useTranslation();
  const label = t(KIND_LABEL[kind].key, { defaultValue: KIND_LABEL[kind].def });
  const glyph = kindGlyph(kind);

  if (!run) {
    return (
      <GlyphCard
        gradient={gradients.paper}
        glyph={glyph}
        glyphColor={colors.textFaint}
        glyphOpacity={0.08}
        glyphSize={128}
        style={styles.advCard}
      >
        <View style={styles.advInner}>
          <MonoLabel>{label}</MonoLabel>
          <Text style={styles.advHeadline} maxFontSizeMultiplier={typeScale.maxMult}>—</Text>
          <Text style={styles.advMuted} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('weather.no_advisory', { defaultValue: 'No advisory' })}
          </Text>
        </View>
      </GlyphCard>
    );
  }

  const pill = advisoryPill(run.kind, run.severity);
  const copy = advisoryCopy(run);
  // a merged run shows its whole span in the headline; singles keep the single day
  const headline =
    run.days > 1 ? `${formatShortDay(run.from)} – ${formatShortDay(run.to)}` : formatShortDay(run.from);
  const body = copy.bodyKey ? t(copy.bodyKey, copy.bodyParams) : copy.fallbackBody;

  return (
    <GlyphCard
      gradient={severityGradient(run.severity)}
      glyph={glyph}
      glyphColor={severityGlyphTone(run.severity)}
      glyphOpacity={0.16}
      glyphSize={130}
      style={styles.advCard}
    >
      <View style={styles.advInner}>
        <View style={styles.advTop}>
          <MonoLabel>{label}</MonoLabel>
          <Pill label={t(pill.key, { defaultValue: pill.def })} fg={pill.fg} bg={pill.bg} />
        </View>
        <Text style={styles.advHeadline} maxFontSizeMultiplier={typeScale.maxMult}>{headline}</Text>
        {copy.titleKey ? (
          <Text style={styles.advBody} maxFontSizeMultiplier={typeScale.maxMult}>
            {t(copy.titleKey, copy.titleParams)}
          </Text>
        ) : null}
        {body ? (
          <Text style={styles.advBody} maxFontSizeMultiplier={typeScale.maxMult}>{body}</Text>
        ) : null}
      </View>
    </GlyphCard>
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
        {/* plain phrase first, acronym in parentheses (docs/DESIGN.md §14) */}
        <Text style={styles.cardTitle} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('weather_human.et_card_title', { defaultValue: 'Acqua richiesta e pioggia (ET₀)' })}
        </Text>
        <View style={styles.legendInline}>
          <LegendSquare
            color={colors.success}
            label={t('weather_human.et0_short', { defaultValue: 'Acqua richiesta (ET₀)' })}
          />
          <LegendSquare color={colors.info} label={t('weather.rain', { defaultValue: 'Rain' })} />
        </View>
      </View>

      {chartData.length > 0 ? (
        <EtChart data={chartData} locale={locale} />
      ) : (
        <Text style={styles.muted} maxFontSizeMultiplier={typeScale.maxMult}>{t('chart.no_data')}</Text>
      )}

      {agro ? (
        <View style={styles.statRow}>
          <Stat
            value={`${formatNumber(agro.et0_7d_mm, { maximumFractionDigits: 0 })} mm`}
            label={t('weather_human.et0_short', { defaultValue: 'Acqua richiesta (ET₀)' })}
          />
          <Stat
            value={`${formatNumber(agro.precip_7d_mm, { maximumFractionDigits: 0 })} mm`}
            label={t('weather.precip_7d', { defaultValue: 'Rain 7d' })}
            color={colors.info}
          />
          <Stat
            value={`${formatNumber(agro.water_balance_7d_mm, { maximumFractionDigits: 0 })} mm`}
            label={t('weather_human.balance', { defaultValue: 'Bilancio idrico' })}
            color={balanceNeg ? colors.accent : colors.text}
          />
          {agro.notes.length > 0 ? (
            <TintCard gradient={gradients.eucalyptus} style={styles.noteCard}>
              <Text style={styles.noteCardText} numberOfLines={2} maxFontSizeMultiplier={typeScale.maxMult}>
                {agro.notes[0]}
              </Text>
            </TintCard>
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

/** Track scale ceiling for the season progress bar (typical full-season GDD budget). */
const GDD_SCALE_MAX = 1000;

function GddCard({ agro, locale }: { agro: AgroSummary | undefined; locale: Locale }) {
  const { t } = useTranslation();

  if (!agro) {
    return (
      <GlyphCard
        gradient={gradients.meadow}
        glyph="sprout"
        glyphColor={colors.success}
        glyphOpacity={0.16}
        glyphSize={140}
        style={styles.gddCard}
      >
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('weather_human.gdd')}
          </Text>
        </View>
        <Text style={styles.muted} maxFontSizeMultiplier={typeScale.maxMult}>{t('chart.no_data')}</Text>
      </GlyphCard>
    );
  }

  const pct = Math.max(0, Math.min(1, agro.gdd.sum / GDD_SCALE_MAX));
  const extraNotes = agro.notes.slice(1); // notes[0] is shown on the ET card

  return (
    <GlyphCard
      gradient={gradients.meadow}
      glyph="sprout"
      glyphColor={colors.success}
      glyphOpacity={0.16}
      glyphSize={140}
      style={styles.gddCard}
    >
      <View style={styles.cardHead}>
        {/* "Caldo accumulato (GDD)" — plain phrase leads, the acronym trails */}
        <Text style={styles.cardTitle} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('weather_human.gdd')}
        </Text>
      </View>

      <View style={styles.gddValueRow}>
        <MonoValue size={44} weight="600">
          {formatNumber(agro.gdd.sum, { maximumFractionDigits: 0 })}
        </MonoValue>
        <MonoLabel size={11} color={colors.textMuted} style={styles.gddUnit}>
          GDD
        </MonoLabel>
      </View>
      <Text style={styles.gddSince} maxFontSizeMultiplier={typeScale.maxMult}>
        {t('weather.gdd_since', {
          defaultValue: 'Accumulated since {{date}}',
          date: format(parseISO(agro.gdd.from_date), 'd MMM yyyy', { locale }),
        })}
      </Text>
      {/* base temperature explained in plain words, not just "Base 10 °C" */}
      <Text style={[styles.noteText, styles.gddBasePlain]} maxFontSizeMultiplier={typeScale.maxMult}>
        {t('weather_human.gdd_base_plain', {
          defaultValue: 'Contiamo solo il caldo sopra {{temp}} °C: sotto quella soglia la coltura non cresce.',
          temp: formatNumber(agro.gdd.base_temp, { maximumFractionDigits: 1 }),
        })}
      </Text>

      <View style={styles.track}>
        <View style={[styles.fill, { width: `${pct * 100}%` }]} />
      </View>
      <View style={styles.scaleRow}>
        <MonoLabel>{formatNumber(0)}</MonoLabel>
        <MonoLabel>{formatNumber(GDD_SCALE_MAX)}</MonoLabel>
      </View>

      {extraNotes.length > 0 ? (
        <View style={styles.noteList}>
          {extraNotes.map((n, i) => (
            <Text key={i} style={styles.noteText} maxFontSizeMultiplier={typeScale.maxMult}>{`– ${n}`}</Text>
          ))}
        </View>
      ) : null}
    </GlyphCard>
  );
}

// ── small pieces ─────────────────────────────────────────────────────────────

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
      {/* type.caption (12) is the floor for data labels in the field */}
      <MonoLabel style={styles.statLabel}>{label}</MonoLabel>
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
  errorText: { color: colors.danger, fontSize: 14, fontFamily: fonts.body },
  mutedLarge: { color: colors.textMuted, fontSize: 15, fontFamily: fonts.body },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  ctaText: { color: colors.onPrimary, fontSize: 15, fontFamily: fonts.bodyBold },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    zIndex: 20,
  },
  flex1: { flex: 1, minWidth: 0 },
  subtitle: { flex: 1, fontSize: 13, color: colors.textMuted, fontFamily: fonts.body },

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
  selectorText: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.textMuted, flexShrink: 1 },
  selectorCaret: { fontSize: 12, color: colors.textFaint, fontFamily: fonts.body },
  selectorHover: { backgroundColor: colors.cardAlt, borderColor: colors.primary },
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
  dropText: { fontSize: 13, color: colors.text, fontFamily: fonts.body },
  dropTextActive: { color: colors.primary, fontFamily: fonts.bodyBold },

  // body
  body: { flex: 1, zIndex: 0 },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xl },
  cardRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },

  // forecast strip
  stripRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  stripPlaceholder: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xl },
  dayCell: {
    flexGrow: 1,
    flexBasis: 66,
    minWidth: 66,
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderRadius: 14,
  },
  dayCellToday: { borderColor: colors.primary, borderWidth: 1.5 },
  dayInner: { alignItems: 'center', gap: 6 },

  // advisory cards
  advCard: { flexGrow: 1, flexBasis: 220, minWidth: 200, padding: spacing.md, borderRadius: radius.lg },
  advInner: { gap: spacing.sm },
  advTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  advHeadline: { fontSize: 17, fontFamily: fonts.display, color: colors.text },
  advBody: { fontSize: 13, color: colors.textMuted, lineHeight: 19, fontFamily: fonts.body },
  advMuted: { fontSize: 13, color: colors.textFaint, fontFamily: fonts.body },

  // ET card
  etCard: { flexGrow: 1.5, flexBasis: 360, minWidth: 300 },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  cardTitle: { fontSize: 16, fontFamily: fonts.display, color: colors.text, flexShrink: 1, lineHeight: 21 },
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
  noteCard: {
    marginLeft: 'auto',
    maxWidth: 260,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm,
  },
  noteCardText: { fontSize: 11.5, color: colors.text, lineHeight: 15, fontFamily: fonts.body },

  // GDD card
  gddCard: { flexGrow: 1, flexBasis: 240, minWidth: 220, padding: spacing.md, borderRadius: radius.lg },
  gddValueRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, marginTop: spacing.xs },
  gddUnit: { paddingBottom: 7 },
  gddSince: { fontSize: 12, color: colors.textMuted, marginTop: 2, fontFamily: fonts.body },
  gddBasePlain: { marginTop: spacing.xs, marginBottom: spacing.md },
  track: {
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.cardAlt,
    overflow: 'hidden',
  },
  fill: { height: '100%', backgroundColor: colors.success, borderRadius: 6 },
  scaleRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs },
  noteList: { gap: spacing.xs, marginTop: spacing.md },
  noteText: { fontSize: 12, color: colors.textMuted, lineHeight: 17, fontFamily: fonts.body },

  // shared
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendSquare: { width: 10, height: 10, borderRadius: 2 },
  legendSquareLabel: { fontSize: 11, color: colors.textMuted, fontFamily: fonts.bodyMedium },
  muted: { color: colors.textMuted, padding: spacing.md, fontFamily: fonts.body },
});

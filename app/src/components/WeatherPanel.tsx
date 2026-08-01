// OWNER: parcel-detail — 7-day forecast strip + plain-language agro stat tiles + advisory
// cards (docs/UX-REVAMP.md; decision-support tone, docs/API.md §Weather). Terra: weather days
// and advisories are conditioned surfaces — each is a GlyphCard (docs/DESIGN.md §5).
// Plain language first: tiles lead with the farmer's phrase ("Acqua richiesta dalle piante"),
// the acronym trails in parentheses, and a small (i) explains each number in one sentence.
// Consecutive same-kind advisory days collapse into ONE card via features/weather/merge.ts —
// never four near-identical heat cards, never ISO dates in prose.
import Ionicons from '@expo/vector-icons/Ionicons';
import { format, parseISO } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgroSummary } from '@/api/types';
import { kindGlyph, weatherGlyph, weatherTone } from '@/components/glyphs';
import { dfLocale } from '@/features/insights/format';
import { notify } from '@/features/parcels/dialog';
import { advisoryCopy, mergeAdvisoryRuns, type AdvisoryRun } from '@/features/weather/merge';
import { formatNumber, formatShortDay } from '@/lib/format';
import {
  colors,
  fonts,
  radius,
  severityGradient,
  severityTint,
  spacing,
  type as typeScale,
  weatherGradient,
} from '@/theme';
import { GlyphCard, MonoLabel, MonoValue } from './ui';
import type { WeatherPanelProps } from './types';

export default function WeatherPanel({ daily, agro, advisories }: WeatherPanelProps) {
  const { t } = useTranslation();
  const forecast = daily.filter((d) => d.is_forecast).slice(0, 7);
  const runs = mergeAdvisoryRuns(advisories);

  return (
    <View style={styles.root}>
      {forecast.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
          {forecast.map((d) => (
            <GlyphCard
              key={d.date}
              gradient={weatherGradient(d.t_min, d.t_max, d.precip_mm)}
              glyph={weatherGlyph(d.t_min, d.t_max, d.precip_mm)}
              glyphColor={weatherTone(weatherGlyph(d.t_min, d.t_max, d.precip_mm))}
              glyphOpacity={0.18}
              glyphSize={76}
              style={styles.day}
            >
              <View style={styles.dayInner}>
                <MonoLabel color={colors.textMuted}>
                  {format(parseISO(d.date), 'EEE', { locale: dfLocale() })}
                </MonoLabel>
                <MonoValue size={15} weight="600" style={styles.tmax}>
                  {fmtTemp(d.t_max)}
                </MonoValue>
                <MonoValue size={12} weight="400" color={colors.textMuted}>
                  {fmtTemp(d.t_min)}
                </MonoValue>
                {(d.precip_mm ?? 0) > 0 ? (
                  <MonoValue size={10} weight="400" color={colors.info}>
                    {formatNumber(Math.round(d.precip_mm as number))} mm
                  </MonoValue>
                ) : null}
              </View>
            </GlyphCard>
          ))}
        </ScrollView>
      ) : (
        <Text style={styles.muted} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('weather.no_forecast')}
        </Text>
      )}

      {agro && <AgroTiles agro={agro} />}

      {runs.length > 0 && (
        <View style={styles.advisories}>
          {runs.map((run, i) => (
            <AdvisoryCard key={`${run.kind}-${run.from}-${i}`} run={run} />
          ))}
        </View>
      )}

      <Text style={styles.caption} maxFontSizeMultiplier={typeScale.maxMult}>
        {t('common.decision_support')}
      </Text>
    </View>
  );
}

/** One card per merged run: plain title ("Ondata di caldo da … a …"), advice body with the
 * peak, localized day range in the mono meta — single days keep single cards. */
function AdvisoryCard({ run }: { run: AdvisoryRun }) {
  const { t } = useTranslation();
  const tint = severityTint[run.severity] ?? severityTint.info;
  const copy = advisoryCopy(run);
  const dates =
    run.days > 1 ? `${formatShortDay(run.from)} – ${formatShortDay(run.to)}` : formatShortDay(run.from);
  const body = copy.bodyKey ? t(copy.bodyKey, copy.bodyParams) : copy.fallbackBody;

  return (
    <GlyphCard
      gradient={severityGradient(run.severity)}
      glyph={kindGlyph(run.kind)}
      glyphColor={tint.fg}
      glyphOpacity={0.14}
      glyphSize={84}
      style={styles.advisory}
    >
      <View style={styles.advisoryInner}>
        <MonoLabel>{dates}</MonoLabel>
        {copy.titleKey ? (
          <Text style={styles.advisoryTitle} maxFontSizeMultiplier={typeScale.maxMult}>
            {t(copy.titleKey, copy.titleParams)}
          </Text>
        ) : null}
        {body ? (
          <Text style={styles.advisoryMsg} maxFontSizeMultiplier={typeScale.maxMult}>
            {body}
          </Text>
        ) : null}
      </View>
    </GlyphCard>
  );
}

function AgroTiles({ agro }: { agro: AgroSummary }) {
  const { t } = useTranslation();
  return (
    <View style={styles.tiles}>
      <StatTile
        label={t('weather_human.et0')}
        value={`${formatNumber(agro.et0_7d_mm, { maximumFractionDigits: 0 })} mm`}
        info={t('weather_human.et0_info', {
          defaultValue:
            'Quanta acqua le piante e il terreno hanno perso con caldo, sole e vento negli ultimi 7 giorni: più è alta, più il campo ha sete.',
        })}
      />
      <StatTile
        label={t('weather_human.balance_7d', { defaultValue: 'Bilancio idrico 7 giorni' })}
        value={fmtBalance(agro.water_balance_7d_mm)}
        valueColor={agro.water_balance_7d_mm < 0 ? colors.danger : colors.info}
        info={t('weather_human.balance_info', {
          defaultValue:
            'Pioggia caduta meno acqua richiesta negli ultimi 7 giorni: sotto zero il campo sta perdendo acqua.',
        })}
      />
      <StatTile
        label={t('weather_human.gdd')}
        value={formatNumber(agro.gdd.sum, { maximumFractionDigits: 0 })}
        info={t('weather_human.gdd_info', {
          defaultValue:
            'La somma del caldo utile accumulato dalla coltura: aiuta a capire a che punto è la stagione.',
        })}
      />
      <StatTile
        label={t('weather_human.balance_30d', { defaultValue: 'Bilancio idrico 30 giorni' })}
        value={fmtBalance(agro.water_balance_30d_mm)}
        valueColor={agro.water_balance_30d_mm < 0 ? colors.danger : colors.info}
        info={t('weather_human.balance_30d_info', {
          defaultValue:
            "Pioggia caduta meno acqua richiesta negli ultimi 30 giorni: l'andamento del mese in un numero.",
        })}
      />
    </View>
  );
}

/** Plain-language stat tile; the (i) opens a one-sentence explanation (native alert). */
function StatTile({
  label,
  value,
  valueColor,
  info,
}: {
  label: string;
  value: string;
  valueColor?: string;
  info: string;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.tile}>
      <View style={styles.tileHead}>
        <Text style={styles.tileLabel} maxFontSizeMultiplier={typeScale.maxMult}>
          {label}
        </Text>
        <Pressable
          onPress={() => notify(label, info)}
          hitSlop={12}
          style={styles.infoBtn}
          accessibilityRole="button"
          accessibilityLabel={`${t('common.what_is_this', { defaultValue: 'Che cos’è' })}: ${label}`}
        >
          <Ionicons name="information-circle-outline" size={16} color={colors.textFaint} />
        </Pressable>
      </View>
      <MonoValue size={16} color={valueColor ?? colors.text} style={styles.tileValue}>
        {value}
      </MonoValue>
    </View>
  );
}

function fmtTemp(v: number | null): string {
  return v == null ? '—' : `${Math.round(v)}°`;
}

function fmtBalance(v: number): string {
  const r = Math.round(v);
  return `${r > 0 ? '+' : ''}${formatNumber(r)} mm`;
}

const styles = StyleSheet.create({
  root: { paddingVertical: spacing.sm },
  strip: { paddingHorizontal: spacing.xs, gap: spacing.xs, paddingVertical: 2 },
  day: { width: 64, height: 92 },
  dayInner: { alignItems: 'center', gap: 1 },
  tmax: { marginTop: 2 },
  muted: { color: colors.textMuted, fontFamily: fonts.body, paddingHorizontal: spacing.sm },
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  tile: {
    flexGrow: 1,
    flexBasis: '46%',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  tileHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs },
  tileLabel: {
    flex: 1,
    fontFamily: fonts.bodySemiBold,
    fontSize: typeScale.caption,
    lineHeight: 16,
    color: colors.textMuted,
  },
  // visual 28pt square; hitSlop 12 lifts the effective target to 52pt (≥ touch.min)
  infoBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -6,
    marginTop: -4,
  },
  tileValue: { marginTop: 2 },
  advisories: { marginTop: spacing.md, gap: spacing.sm },
  advisory: { padding: spacing.md },
  advisoryInner: { gap: 3 },
  advisoryTitle: {
    fontSize: typeScale.body,
    color: colors.text,
    fontFamily: fonts.bodySemiBold,
    lineHeight: 19,
  },
  advisoryMsg: { fontSize: 13, color: colors.text, fontFamily: fonts.body, lineHeight: 18 },
  caption: {
    fontSize: 11,
    color: colors.textFaint,
    fontFamily: fonts.body,
    marginTop: spacing.md,
    paddingHorizontal: spacing.xs,
  },
});

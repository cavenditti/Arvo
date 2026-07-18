// OWNER: fe-dashboard — 7-day forecast strip + GDD/ET0/water-balance chips + advisory badges
// (decision-support tone; see docs/API.md §Weather). Terra: weather days and advisories are
// conditioned surfaces — each is a GlyphCard (semantic gradient + one bleed glyph, docs/DESIGN.md §5).
import { format, parseISO } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgroSummary } from '@/api/types';
import { kindGlyph, weatherGlyph, weatherTone } from '@/components/glyphs';
import { dfLocale } from '@/features/insights/format';
import { colors, fonts, radius, severityGradient, severityTint, spacing, weatherGradient } from '@/theme';
import { GlyphCard, MonoLabel, MonoValue } from './ui';
import type { WeatherPanelProps } from './types';

export default function WeatherPanel({ daily, agro, advisories }: WeatherPanelProps) {
  const { t } = useTranslation();
  const forecast = daily.filter((d) => d.is_forecast).slice(0, 7);

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
                    {Math.round(d.precip_mm as number)} mm
                  </MonoValue>
                ) : null}
              </View>
            </GlyphCard>
          ))}
        </ScrollView>
      ) : (
        <Text style={styles.muted}>{t('weather.no_forecast')}</Text>
      )}

      {agro && <AgroChips agro={agro} />}

      {advisories && advisories.length > 0 && (
        <View style={styles.advisories}>
          {advisories.map((a, i) => {
            const tint = severityTint[a.severity] ?? severityTint.info;
            return (
              <GlyphCard
                key={`${a.kind}-${a.date}-${i}`}
                gradient={severityGradient(a.severity)}
                glyph={kindGlyph(a.kind)}
                glyphColor={tint.fg}
                glyphOpacity={0.14}
                glyphSize={84}
                style={styles.advisory}
              >
                <View style={styles.advisoryInner}>
                  <MonoLabel>{format(parseISO(a.date), 'd MMM', { locale: dfLocale() })}</MonoLabel>
                  <Text style={styles.advisoryMsg}>{a.message}</Text>
                </View>
              </GlyphCard>
            );
          })}
        </View>
      )}

      <Text style={styles.caption}>{t('common.decision_support')}</Text>
    </View>
  );
}

function AgroChips({ agro }: { agro: AgroSummary }) {
  const { t } = useTranslation();
  return (
    <View style={styles.chips}>
      <Chip label={t('weather.gdd')} value={String(Math.round(agro.gdd.sum))} />
      <Chip label={t('weather.et0_7d')} value={`${Math.round(agro.et0_7d_mm)} mm`} />
      <Chip label={t('weather.balance_7d')} value={fmtBalance(agro.water_balance_7d_mm)} balance={agro.water_balance_7d_mm} />
      <Chip label={t('weather.balance_30d')} value={fmtBalance(agro.water_balance_30d_mm)} balance={agro.water_balance_30d_mm} />
    </View>
  );
}

function Chip({ label, value, balance }: { label: string; value: string; balance?: number }) {
  const valueColor =
    balance == null ? colors.text : balance < 0 ? colors.danger : colors.info;
  return (
    <View style={styles.chip}>
      <MonoLabel>{label}</MonoLabel>
      <MonoValue size={16} color={valueColor} style={styles.chipValue}>
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
  return `${r > 0 ? '+' : ''}${r} mm`;
}

const styles = StyleSheet.create({
  root: { paddingVertical: spacing.sm },
  strip: { paddingHorizontal: spacing.xs, gap: spacing.xs, paddingVertical: 2 },
  day: { width: 64, height: 92 },
  dayInner: { alignItems: 'center', gap: 1 },
  tmax: { marginTop: 2 },
  muted: { color: colors.textMuted, fontFamily: fonts.body, paddingHorizontal: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md, paddingHorizontal: spacing.xs },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    minWidth: 78,
  },
  chipValue: { marginTop: 2 },
  advisories: { marginTop: spacing.md, gap: spacing.sm },
  advisory: { padding: spacing.md },
  advisoryInner: { gap: 3 },
  advisoryMsg: { fontSize: 13, color: colors.text, fontFamily: fonts.body, lineHeight: 18 },
  caption: {
    fontSize: 11,
    color: colors.textFaint,
    fontFamily: fonts.body,
    marginTop: spacing.md,
    paddingHorizontal: spacing.xs,
  },
});

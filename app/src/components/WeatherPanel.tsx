// OWNER: fe-dashboard — 7-day forecast strip + GDD/ET0/water-balance chips + advisory badges
// (decision-support tone; see docs/API.md §Weather).
import { format, parseISO } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgroSummary } from '@/api/types';
import { dfLocale, weatherEmoji } from '@/features/insights/format';
import { colors, radius, severityTint, spacing } from '@/theme';
import { TintCard } from './ui';
import type { WeatherPanelProps } from './types';

export default function WeatherPanel({ daily, agro, advisories }: WeatherPanelProps) {
  const { t } = useTranslation();
  const forecast = daily.filter((d) => d.is_forecast).slice(0, 7);

  return (
    <View style={styles.root}>
      {forecast.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
          {forecast.map((d) => (
            <View key={d.date} style={styles.day}>
              <Text style={styles.weekday}>{format(parseISO(d.date), 'EEE', { locale: dfLocale() })}</Text>
              <Text style={styles.emoji}>{weatherEmoji(d)}</Text>
              <Text style={styles.tmax}>{fmtTemp(d.t_max)}</Text>
              <Text style={styles.tmin}>{fmtTemp(d.t_min)}</Text>
              {(d.precip_mm ?? 0) > 0 && (
                <Text style={styles.precip}>{Math.round(d.precip_mm as number)} mm</Text>
              )}
            </View>
          ))}
        </ScrollView>
      ) : (
        <Text style={styles.muted}>{t('weather.no_forecast')}</Text>
      )}

      {agro && <AgroChips agro={agro} />}

      {advisories && advisories.length > 0 && (
        <View style={styles.advisories}>
          {advisories.map((a, i) => (
            <TintCard
              key={`${a.kind}-${a.date}-${i}`}
              tint={(severityTint[a.severity] ?? severityTint.info).bg}
              style={styles.advisory}
            >
              <Text style={styles.advisoryDate}>
                {format(parseISO(a.date), 'd MMM', { locale: dfLocale() })}
              </Text>
              <Text style={styles.advisoryMsg}>{a.message}</Text>
            </TintCard>
          ))}
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
      <Text style={styles.chipLabel}>{label}</Text>
      <Text style={[styles.chipValue, { color: valueColor }]}>{value}</Text>
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
  strip: { paddingHorizontal: spacing.xs, gap: spacing.xs },
  day: {
    width: 54,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
  },
  weekday: { fontSize: 12, fontWeight: '600', color: colors.text, textTransform: 'capitalize' },
  emoji: { fontSize: 20, marginVertical: 2 },
  tmax: { fontSize: 13, fontWeight: '700', color: colors.text },
  tmin: { fontSize: 12, color: colors.textMuted },
  precip: { fontSize: 11, color: colors.info, marginTop: 2 },
  muted: { color: colors.textMuted, paddingHorizontal: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md, paddingHorizontal: spacing.xs },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    minWidth: 78,
  },
  chipLabel: { fontSize: 11, color: colors.textMuted },
  chipValue: { fontSize: 16, fontWeight: '700', color: colors.text },
  advisories: { marginTop: spacing.md, gap: spacing.sm },
  advisory: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  advisoryDate: { fontSize: 11, color: colors.textMuted, textTransform: 'capitalize' },
  advisoryMsg: { fontSize: 13, color: colors.text },
  caption: { fontSize: 11, color: colors.textMuted, marginTop: spacing.md, paddingHorizontal: spacing.xs, fontStyle: 'italic' },
});

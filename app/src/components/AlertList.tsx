// OWNER: fe-dashboard — Campo insight cards: severity glyph badge + title + priority tag, mono meta
// line, message, state pill, and ack/snooze/dismiss actions (snooze expands to inline 1g/3g/7g
// choices) plus an optional "Open parcel →" link.
import { formatDistanceToNow, parseISO } from 'date-fns';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Alert, AlertState } from '@/api/types';
import { kindGlyph } from '@/components/glyphs';
import { GlyphBadge, MonoLabel, Pill, TintCard } from '@/components/ui';
import { dfLocale } from '@/features/insights/format';
import { setSnoozeDays } from '@/features/insights/snooze';
import { colors, fonts, radius, severityGradient, severityTint, spacing } from '@/theme';
import type { AlertListProps } from './types';

const SNOOZE_CHOICES = [1, 3, 7];

const STATE_TINT: Record<AlertState, { fg: string; bg: string }> = {
  open: { fg: colors.primary, bg: colors.primarySoft },
  acked: { fg: colors.textMuted, bg: colors.borderSoft },
  snoozed: { fg: '#5B8F8A', bg: '#E5EEED' },
  dismissed: { fg: colors.textFaint, bg: colors.borderSoft },
};

export default function AlertList({ alerts, onAction, parcelNames, onOpenParcel }: AlertListProps) {
  const { t } = useTranslation();
  const [snoozing, setSnoozing] = useState<string | null>(null);

  return (
    <View style={styles.list}>
      {alerts.map((a) => {
        const sev = severityTint[a.severity] ?? severityTint.info;
        const state = STATE_TINT[a.state];
        const actionable = a.state === 'open' || a.state === 'snoozed';
        const parcelName = a.parcel_id ? parcelNames?.[a.parcel_id] : undefined;
        const ago = formatDistanceToNow(parseISO(a.created_at), {
          addSuffix: true,
          locale: dfLocale(),
        });
        return (
          <TintCard key={a.id} gradient={severityGradient(a.severity)} style={styles.card}>
            <View style={styles.titleRow}>
              <GlyphBadge glyph={kindGlyph(a.kind)} fg={sev.fg} bg={sev.bg} size={28} />
              <Text style={styles.title} numberOfLines={2}>
                {a.title}
              </Text>
              <Pill label={t(`severity.${a.severity}`)} fg={sev.fg} bg={sev.bg} />
            </View>
            <MonoLabel style={styles.meta}>
              {[parcelName, ago].filter(Boolean).join(' · ')}
            </MonoLabel>
            <Text style={styles.message}>{a.message}</Text>

            <View style={styles.footer}>
              <Pill label={t(`alerts.state.${a.state}`)} fg={state.fg} bg={state.bg} />
              {a.parcel_id && onOpenParcel ? (
                <Pressable onPress={() => onOpenParcel(a.parcel_id!)} hitSlop={8}>
                  <Text style={styles.openLink}>{t('alerts.open_parcel')} →</Text>
                </Pressable>
              ) : null}
            </View>

            {actionable && (
              <View style={styles.actions}>
                {snoozing === a.id ? (
                  <>
                    {SNOOZE_CHOICES.map((d) => (
                      <ActionButton
                        key={d}
                        label={t(`alerts.snooze_${d}d`)}
                        onPress={() => {
                          setSnoozeDays(d);
                          onAction(a.id, 'snooze');
                          setSnoozing(null);
                        }}
                      />
                    ))}
                    <ActionButton label={t('common.cancel')} onPress={() => setSnoozing(null)} />
                  </>
                ) : (
                  <>
                    <ActionButton label={t('alerts.ack')} onPress={() => onAction(a.id, 'ack')} />
                    <ActionButton label={t('alerts.snooze')} onPress={() => setSnoozing(a.id)} />
                    <ActionButton label={t('alerts.dismiss')} onPress={() => onAction(a.id, 'dismiss')} />
                  </>
                )}
              </View>
            )}
          </TintCard>
        );
      })}
    </View>
  );
}

function ActionButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}>
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.sm },
  card: {
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flex: 1, fontFamily: fonts.display, fontSize: 15, color: colors.text },
  meta: { marginTop: 6 },
  message: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, marginTop: 6, lineHeight: 18 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  openLink: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.primary },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    paddingTop: spacing.sm,
  },
  action: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardAlt,
  },
  actionPressed: { opacity: 0.6 },
  actionText: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.primaryDark },
});

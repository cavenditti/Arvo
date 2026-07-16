// OWNER: fe-dashboard — severity-bordered alert cards with kind icon, relative time, state chip,
// and ack/snooze/dismiss actions (snooze expands to inline 1g/3g/7g choices).
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Alert, AlertState } from '@/api/types';
import { dfLocale } from '@/features/insights/format';
import { setSnoozeDays } from '@/features/insights/snooze';
import { colors, radius, severityColor, spacing } from '@/theme';
import type { AlertListProps } from './types';

const KIND_ICON: Record<string, keyof typeof MaterialCommunityIcons.glyphMap> = {
  index_drop: 'leaf-off',
  frost_risk: 'snowflake',
  heat_stress: 'thermometer',
};

const SNOOZE_CHOICES = [1, 3, 7];

const STATE_STYLE: Record<AlertState, string> = {
  open: colors.warning,
  acked: colors.success,
  snoozed: colors.info,
  dismissed: colors.textMuted,
};

export default function AlertList({ alerts, onAction, parcelNames }: AlertListProps) {
  const { t } = useTranslation();
  const [snoozing, setSnoozing] = useState<string | null>(null);

  return (
    <View style={styles.list}>
      {alerts.map((a) => {
        const border = severityColor[a.severity] ?? colors.info;
        const actionable = a.state === 'open' || a.state === 'snoozed';
        return (
          <View key={a.id} style={[styles.card, { borderLeftColor: border }]}>
            <View style={styles.row}>
              <MaterialCommunityIcons
                name={KIND_ICON[a.kind] ?? 'alert-circle-outline'}
                size={22}
                color={border}
                style={styles.icon}
              />
              <View style={styles.body}>
                <Text style={styles.title}>{a.title}</Text>
                <Text style={styles.message}>{a.message}</Text>
                <View style={styles.meta}>
                  {a.parcel_id && parcelNames?.[a.parcel_id] && (
                    <Text style={styles.metaText}>{parcelNames[a.parcel_id]}</Text>
                  )}
                  <Text style={styles.metaText}>
                    {formatDistanceToNow(parseISO(a.created_at), { addSuffix: true, locale: dfLocale() })}
                  </Text>
                  <View style={[styles.stateChip, { backgroundColor: STATE_STYLE[a.state] }]}>
                    <Text style={styles.stateChipText}>{t(`alerts.state.${a.state}`)}</Text>
                  </View>
                </View>
              </View>
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
                    <ActionButton icon="check" label={t('alerts.ack')} onPress={() => onAction(a.id, 'ack')} />
                    <ActionButton icon="clock-outline" label={t('alerts.snooze')} onPress={() => setSnoozing(a.id)} />
                    <ActionButton icon="close" label={t('alerts.dismiss')} onPress={() => onAction(a.id, 'dismiss')} />
                  </>
                )}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

function ActionButton({
  icon,
  label,
  onPress,
}: {
  icon?: keyof typeof MaterialCommunityIcons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}>
      {icon && <MaterialCommunityIcons name={icon} size={16} color={colors.primaryDark} />}
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.sm },
  card: {
    backgroundColor: colors.card,
    borderLeftWidth: 4,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: { flexDirection: 'row' },
  icon: { marginRight: spacing.sm, marginTop: 2 },
  body: { flex: 1 },
  title: { fontSize: 15, fontWeight: '700', color: colors.text },
  message: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  meta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  metaText: { fontSize: 11, color: colors.textMuted },
  stateChip: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm },
  stateChipText: { fontSize: 10, fontWeight: '700', color: '#FFFFFF', textTransform: 'uppercase' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  actionPressed: { opacity: 0.6 },
  actionText: { fontSize: 13, fontWeight: '600', color: colors.primaryDark },
});

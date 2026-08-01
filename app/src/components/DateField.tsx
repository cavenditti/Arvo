// OWNER: foundation-ui — localized date field (docs/UX-REVAMP.md frozen contract). Native side of
// the platform fork (web fork: DateField.web.tsx, resolution shim: DateField.d.ts). Stores ISO
// YYYY-MM-DD, always displays the localized prose day — never ISO in user-visible text.
import Ionicons from '@expo/vector-icons/Ionicons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { format } from 'date-fns';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { InteractivePressable } from '@/components/ui';
import i18n from '@/i18n';
import { formatDay } from '@/lib/format';
import * as haptics from '@/lib/haptics';
import { colors, fonts, radius, spacing, touch, type as typeScale } from '@/theme';

export interface DateFieldProps {
  label: string;
  value: string | null;
  onChange(v: string | null): void;
  minimumDate?: Date;
  maximumDate?: Date;
}

function clamp(d: Date, min?: Date, max?: Date): Date {
  if (min && d < min) return min;
  if (max && d > max) return max;
  return d;
}

export default function DateField({
  label,
  value,
  onChange,
  minimumDate,
  maximumDate,
}: DateFieldProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  const selected = value ? new Date(`${value}T00:00:00`) : null;
  const pickerValue = clamp(selected ?? new Date(), minimumDate, maximumDate);

  return (
    <View>
      <Text style={styles.label} maxFontSizeMultiplier={typeScale.maxMult}>
        {label}
      </Text>
      <View style={styles.row}>
        <InteractivePressable
          haptic
          style={styles.field}
          accessibilityLabel={label}
          accessibilityValue={{ text: value ? formatDay(value) : undefined }}
          onPress={() => setOpen(true)}
        >
          <Ionicons name="calendar-outline" size={18} color={colors.textMuted} />
          <Text
            style={[styles.fieldText, !value && styles.placeholder]}
            maxFontSizeMultiplier={typeScale.maxMult}
            numberOfLines={1}
          >
            {value ? formatDay(value) : t('common.pick_date', { defaultValue: 'Scegli una data' })}
          </Text>
        </InteractivePressable>
        {value != null && (
          <InteractivePressable
            style={styles.clear}
            accessibilityLabel={t('common.clear', { defaultValue: 'Rimuovi' })}
            onPress={() => {
              haptics.selection();
              onChange(null);
            }}
          >
            <Ionicons name="close-circle" size={20} color={colors.textFaint} />
          </InteractivePressable>
        )}
      </View>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.backdropWrap}>
          <Pressable
            style={styles.backdrop}
            accessibilityLabel={t('common.close', { defaultValue: 'Chiudi' })}
            onPress={() => setOpen(false)}
          />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.md }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle} maxFontSizeMultiplier={typeScale.maxMult}>
                {label}
              </Text>
              <InteractivePressable style={styles.done} onPress={() => setOpen(false)}>
                <Text style={styles.doneText} maxFontSizeMultiplier={typeScale.maxMult}>
                  {t('common.done', { defaultValue: 'Fine' })}
                </Text>
              </InteractivePressable>
            </View>
            <DateTimePicker
              value={pickerValue}
              mode="date"
              display="inline"
              locale={i18n.language?.startsWith('it') ? 'it-IT' : 'en-US'}
              minimumDate={minimumDate}
              maximumDate={maximumDate}
              accentColor={colors.primary}
              themeVariant="light"
              onValueChange={(_event, date) => {
                haptics.selection();
                onChange(format(date, 'yyyy-MM-dd'));
                setOpen(false);
              }}
              onDismiss={() => setOpen(false)}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 13,
    fontFamily: fonts.bodySemiBold,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: touch.min,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  fieldText: { flex: 1, fontSize: typeScale.bodyLg, fontFamily: fonts.body, color: colors.text },
  placeholder: { color: colors.textFaint },
  clear: {
    minWidth: touch.min,
    minHeight: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backdropWrap: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(27, 30, 26, 0.35)',
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: touch.min,
  },
  sheetTitle: { fontSize: typeScale.title, fontFamily: fonts.display, color: colors.text },
  done: { minHeight: touch.min, justifyContent: 'center', paddingHorizontal: spacing.sm },
  doneText: { fontSize: typeScale.bodyLg, fontFamily: fonts.bodyBold, color: colors.primary },
});

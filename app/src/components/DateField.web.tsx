// OWNER: foundation-ui — web fork of DateField (see DateField.tsx for the native side and
// DateField.d.ts for the resolution shim). Deliberately minimal: a plain YYYY-MM-DD text input
// (web portal polish is out of scope — it must merely compile and work).
import Ionicons from '@expo/vector-icons/Ionicons';
import { isValid, parseISO } from 'date-fns';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { InteractivePressable } from '@/components/ui';
import { colors, fonts, radius, spacing, touch, type as typeScale } from '@/theme';

export interface DateFieldProps {
  label: string;
  value: string | null;
  onChange(v: string | null): void;
  minimumDate?: Date;
  maximumDate?: Date;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export default function DateField({
  label,
  value,
  onChange,
  minimumDate,
  maximumDate,
}: DateFieldProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value ?? '');

  // Adjust state when the controlled value changes (render-phase pattern from the React docs).
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value ?? '');
  }

  const commit = () => {
    const text = draft.trim();
    if (text === '') {
      onChange(null);
      return;
    }
    const parsed = parseISO(text);
    if (
      !ISO_DAY.test(text) ||
      !isValid(parsed) ||
      (minimumDate && parsed < minimumDate) ||
      (maximumDate && parsed > maximumDate)
    ) {
      setDraft(value ?? '');
      return;
    }
    onChange(text);
  };

  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          onBlur={commit}
          onSubmitEditing={commit}
          placeholder="AAAA-MM-GG"
          placeholderTextColor={colors.textFaint}
          accessibilityLabel={label}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {value != null && (
          <InteractivePressable
            style={styles.clear}
            accessibilityLabel={t('common.clear', { defaultValue: 'Rimuovi' })}
            onPress={() => onChange(null)}
          >
            <Ionicons name="close-circle" size={20} color={colors.textFaint} />
          </InteractivePressable>
        )}
      </View>
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
  input: {
    flex: 1,
    minHeight: touch.min,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: typeScale.bodyLg,
    fontFamily: fonts.body,
    color: colors.text,
  },
  clear: {
    minWidth: touch.min,
    minHeight: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

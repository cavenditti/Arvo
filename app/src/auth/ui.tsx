// OWNER: auth-flow — small styled form primitives shared by the auth screens
// (login/register/forgot-password/security). Field-usable: large touch targets,
// plain StyleSheet, theme tokens only, Dynamic Type capped at type.maxMult.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';

import { InteractivePressable, TintCard } from '../components/ui';
import { colors, fonts, gradients, radius, severityTint, spacing, touch, type as typeScale } from '../theme';

export function Field({
  label,
  caption,
  ...props
}: { label: string; caption?: string } & TextInputProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label} maxFontSizeMultiplier={typeScale.maxMult}>
        {label}
      </Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.textMuted}
        accessibilityLabel={label}
        maxFontSizeMultiplier={typeScale.maxMult}
        {...props}
      />
      {caption ? (
        <Text style={styles.caption} maxFontSizeMultiplier={typeScale.maxMult}>
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

/** Password input with a show/hide eye toggle (44pt target inside the field). */
export function PasswordField({
  label,
  caption,
  ...props
}: { label: string; caption?: string } & TextInputProps) {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState(true);
  return (
    <View style={styles.field}>
      <Text style={styles.label} maxFontSizeMultiplier={typeScale.maxMult}>
        {label}
      </Text>
      <View style={styles.inputRow}>
        <TextInput
          style={[styles.input, styles.inputBare]}
          placeholderTextColor={colors.textMuted}
          accessibilityLabel={label}
          maxFontSizeMultiplier={typeScale.maxMult}
          secureTextEntry={hidden}
          autoCapitalize="none"
          {...props}
        />
        <InteractivePressable
          accessibilityRole="button"
          accessibilityLabel={
            hidden
              ? t('auth.show_password', { defaultValue: 'Mostra la password' })
              : t('auth.hide_password', { defaultValue: 'Nascondi la password' })
          }
          onPress={() => setHidden((h) => !h)}
          style={styles.eye}
          hitSlop={4}
        >
          <Ionicons
            name={hidden ? 'eye-outline' : 'eye-off-outline'}
            size={20}
            color={colors.textMuted}
          />
        </InteractivePressable>
      </View>
      {caption ? (
        <Text style={styles.caption} maxFontSizeMultiplier={typeScale.maxMult}>
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

export function PrimaryButton({
  title,
  onPress,
  loading,
  disabled,
}: {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  const off = disabled || loading;
  return (
    <InteractivePressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      haptic
      onPress={onPress}
      disabled={off}
      style={[styles.button, off && styles.buttonMuted]}
    >
      <TintCard gradient={gradients.forest} style={styles.buttonInner}>
        {loading ? (
          <ActivityIndicator color={colors.onPrimary} />
        ) : (
          <Text style={styles.buttonText} maxFontSizeMultiplier={typeScale.maxMult}>
            {title}
          </Text>
        )}
      </TintCard>
    </InteractivePressable>
  );
}

export function LinkButton({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <InteractivePressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={styles.link}
      hoverStyle={styles.linkHover}
      hitSlop={8}
    >
      <Text style={styles.linkText} maxFontSizeMultiplier={typeScale.maxMult}>
        {title}
      </Text>
    </InteractivePressable>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <View style={styles.errorBox} accessibilityRole="alert">
      <Text style={styles.errorText} maxFontSizeMultiplier={typeScale.maxMult}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: spacing.md },
  label: {
    color: colors.textMuted,
    fontSize: typeScale.body,
    marginBottom: spacing.xs,
    fontFamily: fonts.bodySemiBold,
  },
  input: {
    minHeight: 52,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: typeScale.bodyLg,
    fontFamily: fonts.body,
    color: colors.text,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  inputBare: {
    flex: 1,
    minHeight: 50,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: radius.md,
  },
  eye: {
    minWidth: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopRightRadius: radius.md,
    borderBottomRightRadius: radius.md,
  },
  caption: {
    fontSize: typeScale.caption,
    fontFamily: fonts.body,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  button: { marginTop: spacing.sm },
  buttonInner: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderColor: 'transparent',
  },
  buttonMuted: { opacity: 0.6 },
  buttonText: { color: colors.onPrimary, fontSize: typeScale.bodyLg, fontFamily: fonts.bodyBold },
  link: { alignItems: 'center', justifyContent: 'center', minHeight: touch.min, paddingVertical: spacing.sm },
  linkHover: { backgroundColor: colors.primarySoft, borderRadius: radius.md },
  linkText: { color: colors.primary, fontSize: typeScale.bodyLg, fontFamily: fonts.bodySemiBold },
  errorBox: {
    backgroundColor: severityTint.critical.bg,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  errorText: { color: colors.danger, fontSize: typeScale.body, fontFamily: fonts.body },
});

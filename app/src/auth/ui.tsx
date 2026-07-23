// OWNER: fe-shell — small styled form primitives shared by the login/register screens.
// Field-usable: large touch targets, plain StyleSheet, theme tokens only.
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';

import { InteractivePressable, TintCard } from '../components/ui';
import { colors, fonts, gradients, radius, severityTint, spacing } from '../theme';

export function Field({ label, ...props }: { label: string } & TextInputProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={styles.input} placeholderTextColor={colors.textMuted} {...props} />
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
      onPress={onPress}
      disabled={off}
      style={[styles.button, off && styles.buttonMuted]}
    >
      <TintCard gradient={gradients.forest} style={styles.buttonInner}>
        {loading ? (
          <ActivityIndicator color={colors.onPrimary} />
        ) : (
          <Text style={styles.buttonText}>{title}</Text>
        )}
      </TintCard>
    </InteractivePressable>
  );
}

export function LinkButton({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <InteractivePressable accessibilityRole="button" onPress={onPress} style={styles.link} hoverStyle={styles.linkHover} hitSlop={8}>
      <Text style={styles.linkText}>{title}</Text>
    </InteractivePressable>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <View style={styles.errorBox}>
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: spacing.md },
  label: {
    color: colors.textMuted,
    fontSize: 14,
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
    fontSize: 16,
    fontFamily: fonts.body,
    color: colors.text,
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
  buttonText: { color: colors.onPrimary, fontSize: 17, fontFamily: fonts.bodyBold },
  link: { alignItems: 'center', paddingVertical: spacing.md },
  linkHover: { backgroundColor: colors.primarySoft, borderRadius: radius.md },
  linkText: { color: colors.primary, fontSize: 15, fontFamily: fonts.bodySemiBold },
  errorBox: {
    backgroundColor: severityTint.critical.bg,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  errorText: { color: colors.danger, fontSize: 14, fontFamily: fonts.body },
});

// OWNER: fe-shell — Register (creates org).
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner, Field, LinkButton, PrimaryButton } from '../auth/ui';
import Logo from '../components/Logo';
import { colors, fonts, spacing } from '../theme';

export default function RegisterScreen() {
  const { t } = useTranslation();
  const { register } = useAuth();
  const router = useRouter();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    if (!fullName.trim() || !email.trim() || !password || !orgName.trim()) {
      setError(t('auth.fill_all'));
      return;
    }
    if (password.length < 8) {
      setError(t('auth.password_hint'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await register(email.trim(), password, fullName.trim(), orgName.trim());
      // On success the token flips and the root gate redirects into the app.
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('auth.error_generic'));
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brandRow}>
          <Logo variant="plain" size={64} />
          <Text style={styles.brand}>Arvo</Text>
        </View>
        <Text style={styles.title}>{t('auth.register_title')}</Text>
        <Text style={styles.subtitle}>{t('auth.register_subtitle')}</Text>

        {error ? <ErrorBanner message={error} /> : null}

        <Field
          label={t('auth.full_name')}
          value={fullName}
          onChangeText={setFullName}
          autoComplete="name"
          textContentType="name"
        />
        <Field
          label={t('auth.org_name')}
          value={orgName}
          onChangeText={setOrgName}
          autoComplete="organization"
        />
        <Field
          label={t('auth.email')}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          inputMode="email"
          textContentType="emailAddress"
        />
        <Field
          label={t('auth.password')}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          textContentType="newPassword"
          onSubmitEditing={onSubmit}
          returnKeyType="go"
        />
        <Text style={styles.hint}>{t('auth.password_hint')}</Text>

        <PrimaryButton title={t('auth.register_button')} onPress={onSubmit} loading={busy} />
        <LinkButton title={t('auth.have_account')} onPress={() => router.replace('/login')} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.lg,
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg },
  brand: { fontSize: 34, fontFamily: fonts.displayBold, color: colors.primary, letterSpacing: -0.5 },
  title: { fontSize: 24, fontFamily: fonts.display, color: colors.text },
  subtitle: {
    fontSize: 15,
    fontFamily: fonts.body,
    color: colors.textMuted,
    marginBottom: spacing.lg,
    marginTop: spacing.xs,
  },
  hint: {
    fontSize: 13,
    fontFamily: fonts.body,
    color: colors.textMuted,
    marginTop: -spacing.sm,
    marginBottom: spacing.sm,
  },
});

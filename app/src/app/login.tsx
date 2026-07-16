// OWNER: fe-shell — Login (prefill demo@arvo.local/demo1234 in __DEV__).
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
import { colors, spacing } from '../theme';

export default function LoginScreen() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState(__DEV__ ? 'demo@arvo.local' : '');
  const [password, setPassword] = useState(__DEV__ ? 'demo1234' : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    if (!email.trim() || !password) {
      setError(t('auth.fill_all'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
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
          <Logo size={56} />
          <Text style={styles.brand}>Arvo</Text>
        </View>
        <Text style={styles.title}>{t('auth.login_title')}</Text>
        <Text style={styles.subtitle}>{t('auth.login_subtitle')}</Text>

        {error ? <ErrorBanner message={error} /> : null}

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
          textContentType="password"
          onSubmitEditing={onSubmit}
          returnKeyType="go"
        />

        <PrimaryButton title={t('auth.login_button')} onPress={onSubmit} loading={busy} />
        <LinkButton title={t('auth.no_account')} onPress={() => router.push('/register')} />
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
  brand: { fontSize: 34, fontWeight: '800', color: colors.primary, letterSpacing: -0.5 },
  title: { fontSize: 24, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 15, color: colors.textMuted, marginBottom: spacing.lg, marginTop: spacing.xs },
});

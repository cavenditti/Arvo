// OWNER: auth-flow — Register (creates org; account locale = app language).
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
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
import { ErrorBanner, Field, LinkButton, PasswordField, PrimaryButton } from '../auth/ui';
import Logo from '../components/Logo';
import { colors, fonts, spacing, type as typeScale } from '../theme';

export default function RegisterScreen() {
  const { t, i18n } = useTranslation();
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
      // The new account speaks the language this screen is in.
      const locale = i18n.language?.toLowerCase().startsWith('en') ? 'en' : 'it';
      await register(email.trim(), password, fullName.trim(), orgName.trim(), locale);
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
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brandRow}>
          <Logo variant="plain" size={64} />
          <Text style={styles.brand} maxFontSizeMultiplier={typeScale.maxMult}>
            Arvo
          </Text>
        </View>
        <Text
          style={styles.title}
          accessibilityRole="header"
          maxFontSizeMultiplier={typeScale.maxMult}
        >
          {t('auth.register_title')}
        </Text>
        <Text style={styles.subtitle} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('auth.register_subtitle')}
        </Text>

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
          caption={t('auth.org_hint', {
            defaultValue: 'Il nome della tua azienda agricola — puoi cambiarlo quando vuoi',
          })}
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
        <PasswordField
          label={t('auth.password')}
          caption={t('auth.password_hint')}
          value={password}
          onChangeText={setPassword}
          autoComplete="new-password"
          textContentType="newPassword"
          onSubmitEditing={onSubmit}
          returnKeyType="go"
        />

        <Text style={styles.consent} maxFontSizeMultiplier={typeScale.maxMult}>
          <Trans
            i18nKey="auth.consent_line"
            defaults="Creando l'account accetti i <terms>Termini di servizio</terms> e l'<privacy>Informativa sulla privacy</privacy>"
            t={t}
            components={{
              terms: (
                <Text
                  accessibilityRole="link"
                  accessibilityLabel={t('auth.legal_terms')}
                  style={styles.consentLink}
                  onPress={() => router.push('/legal/terms')}
                />
              ),
              privacy: (
                <Text
                  accessibilityRole="link"
                  accessibilityLabel={t('auth.legal_privacy')}
                  style={styles.consentLink}
                  onPress={() => router.push('/legal/privacy')}
                />
              ),
            }}
          />
        </Text>

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
  brand: {
    fontSize: typeScale.hero,
    fontFamily: fonts.displayBold,
    color: colors.primary,
    letterSpacing: -0.5,
  },
  title: { fontSize: typeScale.titleLg, fontFamily: fonts.display, color: colors.text },
  subtitle: {
    fontSize: typeScale.body,
    fontFamily: fonts.body,
    color: colors.textMuted,
    marginBottom: spacing.lg,
    marginTop: spacing.xs,
  },
  consent: {
    fontSize: typeScale.body,
    fontFamily: fonts.body,
    color: colors.textMuted,
    lineHeight: 22,
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  consentLink: {
    color: colors.primary,
    fontFamily: fonts.bodySemiBold,
    textDecorationLine: 'underline',
  },
});

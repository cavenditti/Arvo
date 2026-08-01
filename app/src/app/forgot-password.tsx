// OWNER: auth-flow — account recovery in one screen, two modes:
//  (a) request: email → POST /auth/password-reset/request (server always 204, no
//      account enumeration; the link is only LOGGED server-side for now — the copy
//      promises nothing more than "se l'email esiste, ricevi le istruzioni").
//  (b) confirm: token (deep link arvo:///forgot-password?token=… or pasted via
//      "Ho già un codice") + new password → POST /auth/password-reset/confirm.
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
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

import { api, ApiError } from '../api/client';
import { ErrorBanner, Field, LinkButton, PasswordField, PrimaryButton } from '../auth/ui';
import Logo from '../components/Logo';
import { showToast } from '../components/Toast';
import { TintCard } from '../components/ui';
import * as haptics from '../lib/haptics';
import { colors, fonts, gradients, spacing, type as typeScale } from '../theme';

type Mode = 'request' | 'sent' | 'confirm';

export default function ForgotPasswordScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const deepToken = typeof params.token === 'string' ? params.token : '';

  const [mode, setMode] = useState<Mode>(deepToken ? 'confirm' : 'request');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState(deepToken);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A deep link can land while the screen is already open (cold start races,
  // tapping the link twice): honor the latest token. Render-time state adjustment
  // per react.dev "you might not need an effect".
  const [seenDeepToken, setSeenDeepToken] = useState(deepToken);
  if (deepToken && deepToken !== seenDeepToken) {
    setSeenDeepToken(deepToken);
    setToken(deepToken);
    setMode('confirm');
  }

  function goToLogin() {
    router.replace('/login');
  }

  async function onRequest() {
    if (!email.trim()) {
      setError(t('auth.fill_all'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Always 204 — the server never reveals whether the email exists.
      await api.post('/auth/password-reset/request', { email: email.trim() });
      setMode('sent');
    } catch (e) {
      // Only connectivity/server errors land here, never "email not found".
      setError(e instanceof ApiError ? e.message : t('auth.error_generic'));
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm() {
    if (!token.trim() || !password) {
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
      await api.post('/auth/password-reset/confirm', {
        token: token.trim(),
        new_password: password,
      });
      haptics.success();
      showToast({ message: t('auth.reset_done'), kind: 'success' });
      goToLogin();
    } catch (e) {
      haptics.warning();
      if (e instanceof ApiError && (e.code === 'invalid_token' || e.status === 400)) {
        setError(t('auth.reset_invalid'));
      } else {
        setError(e instanceof ApiError ? e.message : t('auth.error_generic'));
      }
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ headerShown: false, title: t('auth.reset_title') }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.brandRow}>
          <Logo variant="plain" size={64} />
          <Text style={styles.brand} maxFontSizeMultiplier={typeScale.maxMult}>
            Arvo
          </Text>
        </View>

        {mode !== 'confirm' ? (
          <>
            <Text
              style={styles.title}
              accessibilityRole="header"
              maxFontSizeMultiplier={typeScale.maxMult}
            >
              {t('auth.reset_title')}
            </Text>
            <Text style={styles.subtitle} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('auth.reset_body')}
            </Text>
          </>
        ) : (
          <Text
            style={[styles.title, styles.titleSpaced]}
            accessibilityRole="header"
            maxFontSizeMultiplier={typeScale.maxMult}
          >
            {t('auth.reset_new_title')}
          </Text>
        )}

        {error ? <ErrorBanner message={error} /> : null}

        {mode === 'request' ? (
          <>
            <Field
              label={t('auth.email')}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              inputMode="email"
              textContentType="emailAddress"
              onSubmitEditing={onRequest}
              returnKeyType="send"
            />
            <PrimaryButton title={t('auth.reset_send')} onPress={onRequest} loading={busy} />
          </>
        ) : null}

        {mode === 'sent' ? (
          <TintCard gradient={gradients.meadow} style={styles.sentCard}>
            <Text
              style={styles.sentText}
              accessibilityLiveRegion="polite"
              maxFontSizeMultiplier={typeScale.maxMult}
            >
              {t('auth.reset_sent')}
            </Text>
          </TintCard>
        ) : null}

        {mode === 'confirm' ? (
          <>
            <Field
              label={t('auth.reset_token_label', { defaultValue: 'Codice di recupero' })}
              value={token}
              onChangeText={setToken}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="oneTimeCode"
            />
            <PasswordField
              label={t('auth.reset_new_password')}
              caption={t('auth.password_hint')}
              value={password}
              onChangeText={setPassword}
              autoComplete="new-password"
              textContentType="newPassword"
              onSubmitEditing={onConfirm}
              returnKeyType="go"
            />
            <PrimaryButton title={t('auth.reset_confirm')} onPress={onConfirm} loading={busy} />
          </>
        ) : null}

        {mode !== 'confirm' ? (
          <LinkButton
            title={t('auth.reset_have_code', { defaultValue: 'Ho già un codice' })}
            onPress={() => {
              setError(null);
              setMode('confirm');
            }}
          />
        ) : null}
        <LinkButton
          title={t('auth.reset_back', { defaultValue: "Torna all'accesso" })}
          onPress={goToLogin}
        />
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
  titleSpaced: { marginBottom: spacing.lg },
  subtitle: {
    fontSize: typeScale.body,
    fontFamily: fonts.body,
    color: colors.textMuted,
    marginBottom: spacing.lg,
    marginTop: spacing.xs,
  },
  sentCard: { padding: spacing.md, marginBottom: spacing.sm },
  sentText: {
    fontSize: typeScale.bodyLg,
    fontFamily: fonts.bodyMedium,
    color: colors.text,
    lineHeight: 24,
  },
});

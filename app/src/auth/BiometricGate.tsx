// OWNER: auth-flow — full-screen lock shown INSTEAD of the app while a restored
// session waits for Face ID / Touch ID. Rendered by AuthProvider (native only);
// the session token is applied only after onUnlocked fires.
import * as LocalAuthentication from 'expo-local-authentication';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import Logo from '../components/Logo';
import * as haptics from '../lib/haptics';
import { colors, fonts, spacing, type as typeScale } from '../theme';
import { LinkButton, PrimaryButton } from './ui';

export function BiometricLockScreen({
  onUnlocked,
  onLogout,
}: {
  onUnlocked: () => void;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<'busy' | 'failed'>('busy');
  const autoAttempted = useRef(false);

  const attempt = useCallback(async () => {
    setState('busy');
    try {
      const res = await LocalAuthentication.authenticateAsync({
        promptMessage: t('auth.biometric_prompt'),
        cancelLabel: t('common.cancel'),
      });
      if (res.success) {
        haptics.success();
        onUnlocked();
        return;
      }
      haptics.warning();
      setState('failed');
    } catch {
      setState('failed');
    }
  }, [onUnlocked, t]);

  // The shell normally drops the native splash when auth restore settles — but while
  // we're locked the navigator never mounts, so drop it here or the retry/logout UI
  // stays hidden behind the splash forever. hideAsync is idempotent and safe on web.
  useEffect(() => {
    void SplashScreen.hideAsync().catch(() => {});
  }, []);

  // One automatic prompt at open — the farmer just lifts the phone. After a
  // failure/cancel it becomes an explicit choice: retry or sign out.
  useEffect(() => {
    if (autoAttempted.current) return;
    autoAttempted.current = true;
    void attempt();
  }, [attempt]);

  return (
    <View style={styles.flex}>
      <View style={styles.content}>
        <View style={styles.brandRow}>
          <Logo variant="plain" size={64} />
          <Text style={styles.brand} maxFontSizeMultiplier={typeScale.maxMult}>
            Arvo
          </Text>
        </View>
        <Text style={styles.title} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('auth.biometric_prompt')}
        </Text>
        <Text style={styles.body} maxFontSizeMultiplier={typeScale.maxMult}>
          {state === 'failed' ? t('auth.biometric_failed') : t('auth.biometric_hint')}
        </Text>
        <PrimaryButton
          title={
            state === 'failed'
              ? t('common.retry')
              : t('auth.biometric_unlock', { defaultValue: 'Sblocca' })
          }
          onPress={attempt}
          loading={state === 'busy'}
        />
        <LinkButton title={t('settings.logout')} onPress={onLogout} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing.lg,
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  brand: {
    fontSize: typeScale.hero,
    fontFamily: fonts.displayBold,
    color: colors.primary,
    letterSpacing: -0.5,
  },
  title: { fontSize: typeScale.titleLg, fontFamily: fonts.display, color: colors.text },
  body: {
    fontSize: typeScale.body,
    fontFamily: fonts.body,
    color: colors.textMuted,
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
  },
});

// OWNER: auth-flow — security settings: optional Face ID / Touch ID lock.
// Reached from the settings row (push-app renders the row → route '/security').
// The preference only turns on after a successful live authentication, so nobody
// can opt into a lock their sensor cannot open.
import * as LocalAuthentication from 'expo-local-authentication';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { biometricAvailability, type BiometricAvailability } from '../auth/biometric';
import { getBiometricPref, setBiometricPref } from '../auth/storage';
import { showToast } from '../components/Toast';
import { Card, InteractivePressable } from '../components/ui';
import * as haptics from '../lib/haptics';
import { colors, fonts, spacing, touch, type as typeScale } from '../theme';

export default function SecurityScreen() {
  const { t } = useTranslation();
  const [avail, setAvail] = useState<BiometricAvailability | 'checking'>('checking');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const [pref, a] = await Promise.all([getBiometricPref(), biometricAvailability()]);
      if (!mounted) return;
      setEnabled(pref && a === 'available');
      setAvail(a);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  async function onToggle(next: boolean) {
    if (busy) return;
    if (!next) {
      setEnabled(false);
      await setBiometricPref(false);
      haptics.selection();
      return;
    }
    // Prove the sensor works for this person BEFORE saving the preference.
    setBusy(true);
    try {
      const res = await LocalAuthentication.authenticateAsync({
        promptMessage: t('auth.biometric_prompt'),
        cancelLabel: t('common.cancel'),
      });
      if (res.success) {
        setEnabled(true);
        await setBiometricPref(true);
        haptics.success();
      } else {
        haptics.warning();
        showToast({ message: t('auth.biometric_failed'), kind: 'error' });
      }
    } catch {
      showToast({ message: t('auth.biometric_failed'), kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: t('settings.security') }} />
      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        <Card style={styles.card}>
          <Text
            style={styles.heading}
            accessibilityRole="header"
            maxFontSizeMultiplier={typeScale.maxMult}
          >
            {t('auth.biometric_title')}
          </Text>

          {avail === 'checking' ? (
            <ActivityIndicator color={colors.primary} style={styles.spinner} />
          ) : null}

          {avail === 'available' ? (
            <>
              <InteractivePressable
                accessibilityRole="switch"
                accessibilityLabel={t('auth.biometric_toggle')}
                accessibilityState={{ checked: enabled, disabled: busy, busy }}
                onPress={() => void onToggle(!enabled)}
                disabled={busy}
                style={styles.row}
              >
                <Text style={styles.rowLabel} maxFontSizeMultiplier={typeScale.maxMult}>
                  {t('auth.biometric_toggle')}
                </Text>
                <View pointerEvents="none">
                  <Switch
                    value={enabled}
                    trackColor={{ true: colors.primary, false: colors.border }}
                    ios_backgroundColor={colors.border}
                  />
                </View>
              </InteractivePressable>
              <Text style={styles.hint} maxFontSizeMultiplier={typeScale.maxMult}>
                {t('auth.biometric_hint')}
              </Text>
            </>
          ) : null}

          {avail === 'not_enrolled' ? (
            <Text style={styles.hint} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('auth.biometric_not_enrolled', {
                defaultValue:
                  "Per attivare il blocco, configura prima Face ID o l'impronta nelle impostazioni del telefono.",
              })}
            </Text>
          ) : null}

          {avail === 'unavailable' ? (
            <Text style={styles.hint} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('auth.biometric_unavailable')}
            </Text>
          ) : null}
        </Card>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, maxWidth: 640, width: '100%', alignSelf: 'center' },
  card: { padding: spacing.md },
  heading: {
    fontSize: typeScale.title,
    fontFamily: fonts.display,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  spinner: { marginVertical: spacing.md, alignSelf: 'flex-start' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    minHeight: touch.min,
  },
  rowLabel: {
    flex: 1,
    fontSize: typeScale.bodyLg,
    fontFamily: fonts.bodyMedium,
    color: colors.text,
  },
  hint: {
    fontSize: typeScale.body,
    fontFamily: fonts.body,
    color: colors.textMuted,
    lineHeight: 20,
    marginTop: spacing.sm,
  },
});

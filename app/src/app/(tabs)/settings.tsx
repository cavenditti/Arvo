// OWNER: push-app — Profilo: account (+security), organization + switcher, notifications
// (PrimeCard → toggle, docs/UX-REVAMP.md §push-app), language, assistance/legal, about,
// coming-soon teaser, logout. Push wiring lives in @/notifications; this screen only decides
// when to prime and renders honest state (unavailable/denied captions, disabled future prefs).
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import { api } from '@/api/client';
import type { Meta } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { setLang, type Lang } from '@/auth/storage';
import PrimeCard from '@/components/PrimeCard';
import { showToast } from '@/components/Toast';
import { InteractivePressable } from '@/components/ui';
import i18n from '@/i18n';
import * as haptics from '@/lib/haptics';
import {
  isPushPermissionDetermined,
  setupNotifications,
  unregisterPush,
  usePushRegistration,
} from '@/notifications/push';
import { usePushPrefs } from '@/notifications/prefs';
import { colors, fonts, radius, spacing, touch, type as typeScale } from '@/theme';

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle} maxFontSizeMultiplier={typeScale.maxMult}>
        {title}
      </Text>
      {children}
    </View>
  );
}

/** Row with a chevron that navigates or opens a link. ≥48pt, full-row tap target. */
function NavRow({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <InteractivePressable
      haptic
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.navRow}
      pressedStyle={styles.rowPressed}
    >
      <Ionicons name={icon} size={20} color={colors.textMuted} />
      <Text style={styles.navRowLabel} maxFontSizeMultiplier={typeScale.maxMult}>
        {label}
      </Text>
      <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
    </InteractivePressable>
  );
}

/**
 * Label + Switch row where the whole row is the tap target (gloved thumbs). The Switch is
 * purely visual (`pointerEvents="none"`); the row carries the switch semantics.
 */
function ToggleRow({
  label,
  caption,
  value,
  disabled,
  onChange,
}: {
  label: string;
  caption?: string;
  value: boolean;
  disabled?: boolean;
  onChange?: (next: boolean) => void;
}) {
  return (
    <InteractivePressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: disabled === true }}
      disabled={disabled}
      onPress={() => onChange?.(!value)}
      style={styles.toggleRow}
      pressedStyle={styles.rowPressed}
    >
      <View style={styles.toggleTextBlock}>
        <Text
          style={[styles.toggleLabel, disabled && styles.toggleLabelDisabled]}
          maxFontSizeMultiplier={typeScale.maxMult}
        >
          {label}
        </Text>
        {caption != null && (
          <Text style={styles.toggleCaption} maxFontSizeMultiplier={typeScale.maxMult}>
            {caption}
          </Text>
        )}
      </View>
      <View pointerEvents="none">
        <Switch
          value={value}
          disabled={disabled}
          trackColor={{ false: colors.border, true: colors.primary }}
          ios_backgroundColor={colors.border}
        />
      </View>
    </InteractivePressable>
  );
}

export default function SettingsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { status: authStatus, user, org, orgs, role, switchOrg, logout } = useAuth();
  const [switching, setSwitching] = useState<string | null>(null);

  const { prefs, ready: prefsReady, update } = usePushPrefs();
  const pushOn = prefs.pushEnabled;
  const { status: pushStatus } = usePushRegistration(pushOn && authStatus === 'authenticated');
  // null = still checking whether the OS dialog was ever shown (PrimeCard vs toggle row).
  const [permDetermined, setPermDetermined] = useState<boolean | null>(null);
  const prevPushStatus = useRef(pushStatus);

  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/meta') });
  const lang: Lang = i18n.language === 'en' ? 'en' : 'it';
  const appVersion = Constants.expoConfig?.version ?? '—';
  const imageryOn = meta.data?.features.imagery ?? false;

  useEffect(() => {
    setupNotifications();
  }, []);

  // Re-check after each registration attempt: a grant/deny flips 'undetermined' permanently.
  useEffect(() => {
    let alive = true;
    void isPushPermissionDetermined().then((determined) => {
      if (alive) setPermDetermined(determined);
    });
    return () => {
      alive = false;
    };
  }, [pushStatus]);

  // One tactile "done" when the system permission lands — outcomes get notification haptics.
  useEffect(() => {
    if (prevPushStatus.current !== 'granted' && pushStatus === 'granted') haptics.success();
    prevPushStatus.current = pushStatus;
  }, [pushStatus]);

  async function changeLanguage(next: Lang) {
    if (next === lang) return;
    await i18n.changeLanguage(next);
    await setLang(next);
  }

  async function onSwitch(orgId: string) {
    if (orgId === org?.id || switching) return;
    setSwitching(orgId);
    try {
      await switchOrg(orgId);
    } catch {
      showToast({
        kind: 'error',
        message: t('settings.org_switch_failed', {
          defaultValue: 'Non siamo riusciti a cambiare azienda. Riprova.',
        }),
      });
    } finally {
      setSwitching(null);
    }
  }

  function setPushEnabled(next: boolean) {
    haptics.selection();
    update({ pushEnabled: next });
    if (!next) void unregisterPush();
  }

  function openHelpEmail() {
    Linking.openURL('mailto:support@arvo.app').catch(() => {
      showToast({ kind: 'error', message: t('toast.error_retry') });
    });
  }

  function openPhoneSettings() {
    Linking.openSettings().catch(() => {
      // Nothing to do — the caption above already explains the manual path.
    });
  }

  const roleLabel = role ? t(`roles.${role}`) : '—';
  const comingSoon = t('settings.coming_soon', { defaultValue: 'In arrivo' });
  // Prime only when notifications are off AND the OS dialog was never shown; once the user
  // has answered the system prompt (either way) the quiet toggle row is the honest UI.
  const notificationsResolved = prefsReady && permDetermined != null;
  const showPrime = notificationsResolved && !pushOn && permDetermined === false;

  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
    >
      <Text style={styles.pageTitle} maxFontSizeMultiplier={typeScale.maxMult}>
        {t('tabs.settings')}
      </Text>
      <Card title={t('settings.account')}>
        <Text style={styles.primaryLine} maxFontSizeMultiplier={typeScale.maxMult}>
          {user?.full_name ?? '—'}
        </Text>
        <Text style={styles.muted} maxFontSizeMultiplier={typeScale.maxMult}>
          {user?.email ?? '—'}
        </Text>
        <View style={styles.rowDivider} />
        <NavRow
          icon="lock-closed-outline"
          label={t('settings.security')}
          onPress={() => router.push('/security')}
        />
      </Card>

      <Card title={t('settings.organization')}>
        <Text style={styles.primaryLine} maxFontSizeMultiplier={typeScale.maxMult}>
          {org?.name ?? '—'}
        </Text>
        <Text style={styles.muted} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('settings.role')}: {roleLabel}
        </Text>
        {orgs.length > 1 ? (
          <View style={styles.switchBlock}>
            <Text style={styles.subLabel} maxFontSizeMultiplier={typeScale.maxMult}>
              {t('settings.switch_org')}
            </Text>
            {orgs.map((o) => {
              const active = o.id === org?.id;
              return (
                <InteractivePressable
                  key={o.id}
                  accessibilityLabel={o.name}
                  accessibilityState={{ selected: active }}
                  onPress={() => void onSwitch(o.id)}
                  disabled={active || switching !== null}
                  style={styles.orgRow}
                  pressedStyle={styles.rowPressed}
                >
                  <Text
                    style={[styles.orgName, active && styles.orgNameActive]}
                    maxFontSizeMultiplier={typeScale.maxMult}
                  >
                    {o.name}
                  </Text>
                  {switching === o.id ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : active ? (
                    <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
                  ) : (
                    <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                  )}
                </InteractivePressable>
              );
            })}
          </View>
        ) : null}
      </Card>

      {showPrime ? (
        <PrimeCard
          icon="notifications-outline"
          titleKey="prime.notifications_title"
          bodyKey="prime.notifications_body"
          ctaKey="prime.notifications_cta"
          onAccept={() => setPushEnabled(true)}
        />
      ) : (
        <Card title={t('settings.notifications')}>
          {!notificationsResolved ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <>
              <ToggleRow
                label={t('settings.notifications_enable')}
                value={pushOn}
                onChange={setPushEnabled}
              />
              {pushOn && pushStatus === 'unavailable' && (
                <Text style={styles.pushHint} maxFontSizeMultiplier={typeScale.maxMult}>
                  {t('settings.push_unavailable_expogo', {
                    defaultValue:
                      "In questa versione di anteprima gli avvisi non possono arrivare: funzionano solo con l'app installata sul telefono.",
                  })}
                </Text>
              )}
              {pushOn && pushStatus === 'denied' && (
                <>
                  <Text style={styles.pushHint} maxFontSizeMultiplier={typeScale.maxMult}>
                    {t('settings.push_denied', {
                      defaultValue:
                        'Il telefono blocca gli avvisi di Arvo. Puoi riattivarli dalle impostazioni del telefono.',
                    })}
                  </Text>
                  <InteractivePressable
                    accessibilityLabel={t('settings.push_open_settings', {
                      defaultValue: 'Apri le impostazioni del telefono',
                    })}
                    onPress={openPhoneSettings}
                    style={styles.linkRow}
                    pressedStyle={styles.rowPressed}
                  >
                    <Text style={styles.linkText} maxFontSizeMultiplier={typeScale.maxMult}>
                      {t('settings.push_open_settings', {
                        defaultValue: 'Apri le impostazioni del telefono',
                      })}
                    </Text>
                  </InteractivePressable>
                </>
              )}
              <View style={styles.rowDivider} />
              {/* Stored prefs without backend behavior yet — shown disabled, never faked. */}
              <ToggleRow
                label={t('settings.notifications_severe_only')}
                caption={comingSoon}
                value={prefs.severeOnly}
                disabled
              />
              <ToggleRow
                label={t('settings.notifications_digest')}
                caption={comingSoon}
                value={prefs.dailyDigest}
                disabled
              />
            </>
          )}
        </Card>
      )}

      <Card title={t('settings.language')}>
        <View style={styles.langRow}>
          {(['it', 'en'] as const).map((l) => {
            const active = l === lang;
            return (
              <InteractivePressable
                key={l}
                haptic
                accessibilityLabel={l === 'it' ? 'Italiano' : 'English'}
                accessibilityState={{ selected: active }}
                onPress={() => void changeLanguage(l)}
                style={[styles.langChip, active && styles.langChipActive]}
              >
                <Text
                  style={[styles.langText, active && styles.langTextActive]}
                  maxFontSizeMultiplier={typeScale.maxMult}
                >
                  {l === 'it' ? 'Italiano' : 'English'}
                </Text>
              </InteractivePressable>
            );
          })}
        </View>
      </Card>

      <Card title={t('settings.assistance', { defaultValue: 'Assistenza' })}>
        <NavRow icon="mail-outline" label={t('settings.help')} onPress={openHelpEmail} />
        <View style={styles.rowDivider} />
        <Text style={styles.subLabel} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('settings.legal')}
        </Text>
        <NavRow
          icon="shield-checkmark-outline"
          label={t('auth.legal_privacy')}
          onPress={() => router.push('/legal/privacy')}
        />
        <NavRow
          icon="document-text-outline"
          label={t('auth.legal_terms')}
          onPress={() => router.push('/legal/terms')}
        />
      </Card>

      <Card title={t('settings.about')}>
        <View style={styles.aboutRow}>
          <Text style={styles.muted} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('about.version')}
          </Text>
          <Text style={styles.aboutValue} maxFontSizeMultiplier={typeScale.maxMult}>
            {appVersion}
          </Text>
        </View>
        <View style={styles.aboutRow}>
          <Text style={styles.muted} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('about.imagery')}
          </Text>
          <View style={[styles.badge, imageryOn ? styles.badgeOn : styles.badgeOff]}>
            <Text
              style={[styles.badgeText, imageryOn ? styles.badgeTextOn : styles.badgeTextOff]}
              maxFontSizeMultiplier={typeScale.maxMult}
            >
              {imageryOn ? t('common.on') : t('common.off')}
            </Text>
          </View>
        </View>
        <Text style={styles.disclaimer} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('common.decision_support')}
        </Text>
      </Card>

      {/* Deliberate product teaser (docs/BUSINESS.md roadmap) — quiet, non-interactive. */}
      <View style={styles.comingCard}>
        <Text style={styles.comingTitle} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('settings.coming_soon_quaderno')}
        </Text>
        <Text style={styles.comingBody} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('settings.coming_soon_quaderno_body', {
            defaultValue:
              'Trattamenti, concimazioni e registri pronti per i controlli, direttamente dal telefono.',
          })}
        </Text>
      </View>

      <InteractivePressable
        accessibilityLabel={t('settings.logout')}
        haptic
        onPress={() => void logout()}
        style={styles.logout}
        pressedStyle={styles.rowPressed}
      >
        <Ionicons name="log-out-outline" size={20} color={colors.danger} />
        <Text style={styles.logoutText} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('settings.logout')}
        </Text>
      </InteractivePressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md },
  pageTitle: {
    color: colors.text,
    fontFamily: fonts.display,
    fontSize: typeScale.hero,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  cardTitle: {
    fontSize: typeScale.title,
    fontFamily: fonts.display,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  primaryLine: { fontSize: typeScale.title, fontFamily: fonts.bodySemiBold, color: colors.text },
  muted: { fontSize: typeScale.body, fontFamily: fonts.body, color: colors.textMuted },
  subLabel: {
    fontSize: typeScale.caption,
    fontFamily: fonts.bodySemiBold,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  rowDivider: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    marginVertical: spacing.sm,
  },
  switchBlock: {
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
  },
  orgRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
  },
  rowPressed: { backgroundColor: colors.bg },
  orgName: { fontSize: typeScale.bodyLg, fontFamily: fonts.body, color: colors.text },
  orgNameActive: { fontFamily: fonts.bodyBold, color: colors.primary },
  navRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.md,
  },
  navRowLabel: {
    flex: 1,
    fontSize: typeScale.bodyLg,
    fontFamily: fonts.bodyMedium,
    color: colors.text,
  },
  toggleRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.md,
  },
  toggleTextBlock: { flex: 1, gap: 2 },
  toggleLabel: { fontSize: typeScale.bodyLg, fontFamily: fonts.bodyMedium, color: colors.text },
  toggleLabelDisabled: { color: colors.textMuted },
  toggleCaption: { fontSize: typeScale.caption, fontFamily: fonts.body, color: colors.textFaint },
  pushHint: {
    fontSize: typeScale.body,
    fontFamily: fonts.body,
    color: colors.textMuted,
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.xs,
  },
  linkRow: {
    minHeight: touch.min,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    borderRadius: radius.md,
  },
  linkText: { fontSize: typeScale.body, fontFamily: fonts.bodySemiBold, color: colors.primary },
  langRow: { flexDirection: 'row', gap: spacing.sm },
  langChip: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  langChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  langText: { fontSize: typeScale.bodyLg, fontFamily: fonts.bodySemiBold, color: colors.text },
  langTextActive: { color: colors.onPrimary },
  aboutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
  },
  aboutValue: { fontSize: typeScale.body, fontFamily: fonts.monoSemiBold, color: colors.text },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm },
  badgeOn: { backgroundColor: colors.primarySoft },
  badgeOff: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  badgeText: { fontSize: typeScale.caption, fontFamily: fonts.bodyBold },
  badgeTextOn: { color: colors.success },
  badgeTextOff: { color: colors.textMuted },
  disclaimer: {
    fontSize: typeScale.caption,
    fontFamily: fonts.body,
    color: colors.textFaint,
    marginTop: spacing.sm,
  },
  comingCard: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    padding: spacing.md,
    gap: spacing.xs,
  },
  comingTitle: { fontSize: typeScale.body, fontFamily: fonts.bodySemiBold, color: colors.textMuted },
  comingBody: { fontSize: typeScale.body, fontFamily: fonts.body, color: colors.textFaint },
  logout: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  logoutText: { fontSize: typeScale.bodyLg, fontFamily: fonts.bodyBold, color: colors.danger },
});

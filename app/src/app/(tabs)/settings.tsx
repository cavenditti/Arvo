// OWNER: fe-shell — Settings — profile, org, language toggle, logout, about/meta.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { api } from '../../api/client';
import type { Meta } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { setLang, type Lang } from '../../auth/storage';
import i18n from '../../i18n';
import { colors, radius, spacing } from '../../theme';

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

export default function SettingsScreen() {
  const { t } = useTranslation();
  const { user, org, orgs, role, switchOrg, logout } = useAuth();
  const [switching, setSwitching] = useState<string | null>(null);

  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/meta') });
  const lang: Lang = i18n.language === 'en' ? 'en' : 'it';
  const appVersion = Constants.expoConfig?.version ?? '—';
  const imageryOn = meta.data?.features.imagery ?? false;

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
      // stay on current org on failure
    } finally {
      setSwitching(null);
    }
  }

  const roleLabel = role ? t(`roles.${role}`) : '—';

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Card title={t('settings.account')}>
        <Text style={styles.primaryLine}>{user?.full_name ?? '—'}</Text>
        <Text style={styles.muted}>{user?.email ?? '—'}</Text>
      </Card>

      <Card title={t('settings.organization')}>
        <Text style={styles.primaryLine}>{org?.name ?? '—'}</Text>
        <Text style={styles.muted}>
          {t('settings.role')}: {roleLabel}
        </Text>
        {orgs.length > 1 ? (
          <View style={styles.switchBlock}>
            <Text style={styles.subLabel}>{t('settings.switch_org')}</Text>
            {orgs.map((o) => {
              const active = o.id === org?.id;
              return (
                <Pressable
                  key={o.id}
                  onPress={() => onSwitch(o.id)}
                  disabled={active || switching !== null}
                  style={({ pressed }) => [styles.orgRow, pressed && !active && styles.rowPressed]}
                >
                  <Text style={[styles.orgName, active && styles.orgNameActive]}>{o.name}</Text>
                  {switching === o.id ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : active ? (
                    <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
                  ) : (
                    <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                  )}
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </Card>

      <Card title={t('settings.language')}>
        <View style={styles.langRow}>
          {(['it', 'en'] as const).map((l) => {
            const active = l === lang;
            return (
              <Pressable
                key={l}
                onPress={() => changeLanguage(l)}
                style={[styles.langChip, active && styles.langChipActive]}
              >
                <Text style={[styles.langText, active && styles.langTextActive]}>
                  {l === 'it' ? 'Italiano' : 'English'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Card>

      <Card title={t('settings.about')}>
        <View style={styles.aboutRow}>
          <Text style={styles.muted}>{t('about.version')}</Text>
          <Text style={styles.aboutValue}>{appVersion}</Text>
        </View>
        <View style={styles.aboutRow}>
          <Text style={styles.muted}>{t('about.imagery')}</Text>
          <View style={[styles.badge, imageryOn ? styles.badgeOn : styles.badgeOff]}>
            <Text style={[styles.badgeText, imageryOn ? styles.badgeTextOn : styles.badgeTextOff]}>
              {imageryOn ? t('common.on') : t('common.off')}
            </Text>
          </View>
        </View>
        <Text style={styles.disclaimer}>{t('common.decision_support')}</Text>
      </Card>

      <Pressable
        accessibilityRole="button"
        onPress={() => void logout()}
        style={({ pressed }) => [styles.logout, pressed && styles.rowPressed]}
      >
        <Ionicons name="log-out-outline" size={20} color={colors.danger} />
        <Text style={styles.logoutText}>{t('settings.logout')}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  primaryLine: { fontSize: 18, fontWeight: '600', color: colors.text },
  muted: { fontSize: 14, color: colors.textMuted },
  subLabel: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: spacing.xs },
  switchBlock: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
  orgRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
  },
  rowPressed: { backgroundColor: colors.bg },
  orgName: { fontSize: 16, color: colors.text },
  orgNameActive: { fontWeight: '700', color: colors.primary },
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
  langText: { fontSize: 16, fontWeight: '600', color: colors.text },
  langTextActive: { color: colors.onPrimary },
  aboutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
  },
  aboutValue: { fontSize: 14, fontWeight: '600', color: colors.text },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm },
  badgeOn: { backgroundColor: colors.primarySoft },
  badgeOff: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  badgeText: { fontSize: 13, fontWeight: '700' },
  badgeTextOn: { color: colors.success },
  badgeTextOff: { color: colors.textMuted },
  disclaimer: { fontSize: 12, color: colors.textMuted, marginTop: spacing.sm, fontStyle: 'italic' },
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
  logoutText: { fontSize: 16, fontWeight: '700', color: colors.danger },
});

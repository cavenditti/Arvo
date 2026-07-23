// OWNER: web-shell — Campo web portal chrome: fixed sidebar (logo, org card, nav with badges,
// user footer) + scrollable content area. Wraps every web route; parcel/[id].web.tsx imports it
// directly. Keep the exported props contract stable: { children }.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { useRouter, usePathname } from 'expo-router';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { api } from '@/api/client';
import type { Alert } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import Logo from '@/components/Logo';
import { GlyphBadge, InteractivePressable, MonoLabel, initials } from '@/components/ui';
import { useOutsideDismiss } from '@/components/useOutsideDismiss';
import { colors, fonts, radius, spacing } from '@/theme';

type NavItem = {
  key: string;
  labelKey: string;
  fallback: string;
  icon: keyof typeof Ionicons.glyphMap;
  path?: string; // undefined → disabled (coming soon)
  match?: (pathname: string) => boolean;
};

const NAV: NavItem[] = [
  {
    key: 'fields',
    labelKey: 'tabs.dashboard',
    fallback: 'Fields',
    icon: 'grid-outline',
    path: '/',
    match: (p) =>
      p === '/' ||
      p.startsWith('/parcel') ||
      p.startsWith('/plants') ||
      p.startsWith('/plant/') ||
      p.startsWith('/capture'),
  },
  { key: 'map', labelKey: 'tabs.map', fallback: 'Map', icon: 'navigate-outline', path: '/map' },
  {
    key: 'insights',
    labelKey: 'alerts.title',
    fallback: 'Insights',
    icon: 'warning-outline',
    path: '/alerts',
  },
  { key: 'weather', labelKey: 'tabs.weather', fallback: 'Weather', icon: 'sunny-outline', path: '/weather' },
  { key: 'reports', labelKey: 'portal.reports', fallback: 'Reports', icon: 'document-text-outline' },
  { key: 'devices', labelKey: 'portal.devices', fallback: 'Devices', icon: 'hardware-chip-outline' },
];

export default function PortalShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { user, org, orgs, role, switchOrg } = useAuth();
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [switchingOrg, setSwitchingOrg] = useState<string | null>(null);
  const workspaceRef = useRef<View | null>(null);
  const closeWorkspace = useCallback(() => setWorkspaceOpen(false), []);
  useOutsideDismiss(workspaceRef, workspaceOpen, closeWorkspace);

  const openAlerts = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: () => api.get<Alert[]>('/alerts?state=open'),
  });

  const openCount = openAlerts.data?.length ?? 0;
  const fullName = user?.full_name ?? '—';
  const avatarInitials = initials(fullName);
  const canSwitchWorkspace = orgs.length > 1;

  async function onSwitchWorkspace(orgId: string) {
    if (orgId === org?.id) {
      setWorkspaceOpen(false);
      return;
    }
    if (switchingOrg) return;
    setSwitchingOrg(orgId);
    try {
      await switchOrg(orgId);
      setWorkspaceOpen(false);
    } catch {
      // Keep the current workspace and menu open so the user can retry.
    } finally {
      setSwitchingOrg(null);
    }
  }

  return (
    <View style={styles.root}>
      <View style={styles.sidebar}>
        <View style={styles.brandRow}>
          <Logo size={34} />
          <Text style={styles.brand}>Arvo</Text>
        </View>

        <View ref={workspaceRef} style={styles.workspaceBlock}>
          <View style={styles.orgCard}>
            <GlyphBadge glyph="sprout" fg={colors.success} bg={colors.primarySoft} size={22} />
            <View style={styles.flex1}>
              <MonoLabel size={9}>{t('portal.workspace')}</MonoLabel>
              <Text style={styles.orgName} numberOfLines={1}>
                {org?.name ?? '—'}
              </Text>
            </View>
          </View>
          {canSwitchWorkspace ? (
            <InteractivePressable
              style={styles.switchWorkspaceButton}
              hoverStyle={styles.switchWorkspaceHover}
              accessibilityState={{ expanded: workspaceOpen }}
              onPress={() => setWorkspaceOpen((open) => !open)}
            >
              <Ionicons name="swap-horizontal-outline" size={14} color={colors.primary} />
              <Text style={styles.switchWorkspaceText}>{t('portal.switch_workspace')}</Text>
              <Ionicons
                name={workspaceOpen ? 'chevron-up' : 'chevron-down'}
                size={13}
                color={colors.textFaint}
              />
            </InteractivePressable>
          ) : null}
          {workspaceOpen ? (
            <View style={styles.workspaceMenu}>
              {orgs.map((membership) => {
                const active = membership.id === org?.id;
                return (
                  <InteractivePressable
                    key={membership.id}
                    style={[styles.workspaceItem, active && styles.workspaceItemActive]}
                    hoverStyle={!active ? styles.workspaceItemHover : undefined}
                    onPress={() => void onSwitchWorkspace(membership.id)}
                    disabled={switchingOrg !== null && switchingOrg !== membership.id}
                  >
                    <View style={styles.flex1}>
                      <Text
                        style={[styles.workspaceItemName, active && styles.workspaceItemNameActive]}
                        numberOfLines={1}
                      >
                        {membership.name}
                      </Text>
                      <MonoLabel size={9}>{t(`roles.${membership.role}`)}</MonoLabel>
                    </View>
                    {switchingOrg === membership.id ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : active ? (
                      <Ionicons name="checkmark" size={16} color={colors.primary} />
                    ) : null}
                  </InteractivePressable>
                );
              })}
            </View>
          ) : null}
        </View>

        <View style={styles.nav}>
          {NAV.map((item) => {
            const active = item.path
              ? item.match
                ? item.match(pathname)
                : pathname === item.path
              : false;
            const disabled = !item.path;
            return (
              <InteractivePressable
                key={item.key}
                disabled={disabled}
                onPress={() => item.path && router.push(item.path)}
                style={[styles.navItem, active && styles.navItemActive]}
                hoverStyle={!active && !disabled ? styles.navItemHover : undefined}
              >
                <Ionicons
                  name={item.icon}
                  size={18}
                  color={active ? colors.primary : disabled ? colors.textFaint : colors.textMuted}
                />
                <Text
                  style={[
                    styles.navLabel,
                    active && styles.navLabelActive,
                    disabled && styles.navLabelDisabled,
                  ]}
                  numberOfLines={1}
                >
                  {t(item.labelKey, { defaultValue: item.fallback })}
                </Text>
                {item.key === 'insights' && openCount > 0 ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{openCount}</Text>
                  </View>
                ) : null}
                {disabled ? (
                  <View style={styles.soonChip}>
                    <Text style={styles.soonText}>{t('portal.soon')}</Text>
                  </View>
                ) : null}
              </InteractivePressable>
            );
          })}
        </View>

        <View style={styles.footer}>
          <View style={styles.divider} />
          <InteractivePressable
            onPress={() => router.push('/settings')}
            style={styles.userRow}
            hoverStyle={styles.userRowHover}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{avatarInitials}</Text>
            </View>
            <View style={styles.flex1}>
              <Text style={styles.userName} numberOfLines={1}>
                {fullName}
              </Text>
              <MonoLabel size={10}>{role ? t(`roles.${role}`) : ''}</MonoLabel>
            </View>
            <Ionicons name="settings-outline" size={14} color={colors.textFaint} />
          </InteractivePressable>
        </View>
      </View>

      {pathname === '/map' ? (
        // full-bleed pages (the map) need a real flex fill, not a content-sized scroll area
        <View style={styles.mainFull}>{children}</View>
      ) : (
        <ScrollView style={styles.main} contentContainerStyle={styles.mainContent}>
          {children}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: colors.bg },
  flex1: { flex: 1, minWidth: 0 },
  sidebar: {
    width: 232,
    backgroundColor: colors.card,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.lg,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.md,
  },
  brand: { fontSize: 17, fontFamily: fonts.displayBold, color: colors.text, letterSpacing: -0.2 },
  workspaceBlock: { position: 'relative', zIndex: 30, marginTop: spacing.sm },
  orgCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 9,
    paddingHorizontal: 11,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  orgName: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.text },
  switchWorkspaceButton: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.xs,
    paddingHorizontal: 10,
    borderRadius: radius.sm,
  },
  switchWorkspaceHover: { backgroundColor: colors.primarySoft },
  switchWorkspaceText: {
    flex: 1,
    fontFamily: fonts.bodySemiBold,
    fontSize: 11.5,
    color: colors.primary,
  },
  workspaceMenu: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: spacing.xs,
    padding: spacing.xs,
    gap: 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  workspaceItem: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
  },
  workspaceItemActive: { backgroundColor: colors.primarySoft },
  workspaceItemHover: { backgroundColor: colors.cardAlt },
  workspaceItemName: { fontFamily: fonts.bodyMedium, fontSize: 12.5, color: colors.text },
  workspaceItemNameActive: { fontFamily: fonts.bodySemiBold, color: colors.primary },
  nav: { marginTop: spacing.lg, gap: 2 },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: radius.sm,
  },
  navItemActive: { backgroundColor: colors.primarySoft },
  navItemHover: { backgroundColor: colors.cardAlt },
  navLabel: { fontSize: 13.5, fontFamily: fonts.bodyMedium, color: colors.textMuted, flex: 1 },
  navLabelActive: { color: colors.primary, fontFamily: fonts.bodySemiBold },
  navLabelDisabled: { color: colors.textFaint },
  badge: {
    minWidth: 18,
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontFamily: fonts.bodyBold, color: colors.onPrimary, fontSize: 10 },
  soonChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  soonText: { fontFamily: fonts.mono, fontSize: 10, color: colors.textFaint },
  footer: { marginTop: 'auto' },
  divider: {
    height: 1,
    backgroundColor: colors.borderSoft,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    marginHorizontal: spacing.xs,
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
  },
  userRowHover: { backgroundColor: colors.cardAlt },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 12, fontFamily: fonts.bodySemiBold, color: colors.primary },
  userName: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.text },
  main: { flex: 1 },
  mainFull: { flex: 1 },
  mainContent: { padding: spacing.lg, maxWidth: 1280, width: '100%', alignSelf: 'center' },
});

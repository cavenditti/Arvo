// OWNER: web-shell — Campo web portal chrome: fixed sidebar (logo, org card, nav with badges,
// user footer) + scrollable content area. Wraps every web route; parcel/[id].web.tsx imports it
// directly. Keep the exported props contract stable: { children }.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { useRouter, usePathname } from 'expo-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { api } from '@/api/client';
import type { Alert, Org, Parcel, Role, User } from '@/api/types';
import Logo from '@/components/Logo';
import { GlyphBadge, MonoLabel } from '@/components/ui';
import { colors, fonts, radius, spacing } from '@/theme';

type Me = { user: User; org: Org; role: Role };

// Web-only Pressable render-prop state (`hovered` is added by react-native-web, absent from RN types).
type PressState = { hovered?: boolean; pressed: boolean };

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
    match: (p) => p === '/' || p.startsWith('/parcel'),
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

  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: () => api.get<Me>('/auth/me') });
  const parcels = useQuery({ queryKey: ['parcels'], queryFn: () => api.get<Parcel[]>('/parcels') });
  const openAlerts = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: () => api.get<Alert[]>('/alerts?state=open'),
  });

  const parcelCount = (parcels.data ?? []).length;
  const totalHa = (parcels.data ?? []).reduce((s, p) => s + p.area_ha, 0);
  const openCount = openAlerts.data?.length ?? 0;
  const fullName = me.data?.user.full_name ?? '—';
  const initials = fullName
    .split(' ')
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <View style={styles.root}>
      <View style={styles.sidebar}>
        <View style={styles.brandRow}>
          <Logo size={34} />
          <Text style={styles.brand}>Arvo</Text>
        </View>

        {/* Org selector — display only; org switching lives in /settings. */}
        <View style={styles.orgCard}>
          <GlyphBadge glyph="sprout" fg={colors.success} bg={colors.primarySoft} size={22} />
          <View style={styles.flex1}>
            <Text style={styles.orgName} numberOfLines={1}>
              {me.data?.org.name ?? '—'}
            </Text>
            <Text style={styles.orgMeta} numberOfLines={1}>
              {parcelCount} {t('portal.parcels', { defaultValue: 'parcels' })} · {totalHa.toFixed(1)} ha
            </Text>
          </View>
          <Ionicons name="chevron-down" size={14} color={colors.textFaint} />
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
              <Pressable
                key={item.key}
                disabled={disabled}
                onPress={() => item.path && router.push(item.path)}
                style={({ hovered, pressed }: PressState) => [
                  styles.navItem,
                  active && styles.navItemActive,
                  (hovered || pressed) && !active && !disabled && styles.navItemHover,
                ]}
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
                    <Text style={styles.soonText}>A</Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>

        <View style={styles.footer}>
          <View style={styles.divider} />
          <Pressable
            onPress={() => router.push('/settings')}
            style={({ hovered, pressed }: PressState) => [
              styles.userRow,
              (hovered || pressed) && styles.userRowHover,
            ]}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials}</Text>
            </View>
            <View style={styles.flex1}>
              <Text style={styles.userName} numberOfLines={1}>
                {fullName}
              </Text>
              <MonoLabel size={10}>{me.data?.role ? t(`roles.${me.data.role}`) : ''}</MonoLabel>
            </View>
            <Ionicons name="settings-outline" size={14} color={colors.textFaint} />
          </Pressable>
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
  orgCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    paddingVertical: 9,
    paddingHorizontal: 11,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  orgName: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.text },
  orgMeta: { fontFamily: fonts.mono, fontSize: 10, color: colors.textFaint, marginTop: 2 },
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

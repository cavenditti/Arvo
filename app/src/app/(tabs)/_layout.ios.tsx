// OWNER: shell-nav — iOS 26 keeps Expo Router's native tab navigator for routing and
// screen state, but replaces its visible bar with FabNativeTabs' UIKit/SwiftUI glass bar.
// This gives creation its own trailing FAB without spending a second row above the tabs.
// Older iOS versions retain Expo's system bar and bottom-accessory fallback.
import Ionicons from '@expo/vector-icons/Ionicons';
import { requireNativeViewManager } from 'expo-modules-core';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Platform,
  StyleSheet,
  Text,
  type ColorValue,
  type NativeSyntheticEvent,
  type ViewProps,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api } from '@/api/client';
import type { Alert } from '@/api/types';
import { InteractivePressable } from '@/components/ui';
import { countAlertEvents } from '@/features/insights/grouping';
import { colors, fonts, spacing, type as typeScale } from '@/theme';

const tabContentStyle = { backgroundColor: colors.bg } as const;
const isIOS26 = Number.parseInt(String(Platform.Version), 10) >= 26;

const tabRoutes = [
  {
    name: 'index',
    href: '/' as const,
    sf: { default: 'square.grid.2x2', selected: 'square.grid.2x2.fill' },
    md: 'dashboard',
    translationKey: 'tabs.dashboard',
  },
  {
    name: 'map',
    href: '/map' as const,
    sf: { default: 'location.north', selected: 'location.north.fill' },
    md: 'navigation',
    translationKey: 'tabs.map',
  },
  {
    name: 'alerts',
    href: '/alerts' as const,
    sf: {
      default: 'exclamationmark.triangle',
      selected: 'exclamationmark.triangle.fill',
    },
    md: 'warning',
    translationKey: 'tabs.alerts',
  },
  {
    name: 'settings',
    href: '/settings' as const,
    sf: { default: 'person.crop.circle', selected: 'person.crop.circle.fill' },
    md: 'account_circle',
    translationKey: 'tabs.settings',
  },
] as const;

interface FabTabsViewProps extends ViewProps {
  tabs: {
    value: string;
    title: string;
    systemImage: string;
    selectedSystemImage: string;
  }[];
  selectedIndex: number;
  fabSystemImage: string;
  fabAccessibilityLabel: string;
  accentColor: ColorValue;
  showFab: boolean;
  onTabChange: (event: NativeSyntheticEvent<{ index: number }>) => void;
  onFabPress: () => void;
}

const NativeFabTabsView = requireNativeViewManager<FabTabsViewProps>('FabNativeTabs');

function AddAccessory() {
  const { t } = useTranslation();
  const router = useRouter();
  const placement = NativeTabs.BottomAccessory.usePlacement();
  const inline = placement === 'inline';

  return (
    <InteractivePressable
      haptic
      onPress={() => router.push('/add-actions')}
      accessibilityLabel={t('menu.add')}
      accessibilityHint={t('menu.add_hint')}
      style={[styles.addAccessory, inline && styles.addAccessoryInline]}
      pressedStyle={styles.addAccessoryPressed}
    >
      <Ionicons name="add" size={inline ? 25 : 22} color={colors.primary} />
      {!inline ? (
        <Text style={styles.addAccessoryText} maxFontSizeMultiplier={typeScale.maxMult}>
          {t('menu.add')}
        </Text>
      ) : null}
    </InteractivePressable>
  );
}

function TabNavigator({ hidden, eventCount }: { hidden: boolean; eventCount: number }) {
  const { t } = useTranslation();
  const alertBadge = eventCount > 99 ? '99+' : String(eventCount);

  return (
    <NativeTabs
      backBehavior="history"
      badgeBackgroundColor={colors.accent}
      hidden={hidden}
      minimizeBehavior="automatic"
      tintColor={colors.primary}
    >
      {!hidden ? (
        <NativeTabs.BottomAccessory>
          <AddAccessory />
        </NativeTabs.BottomAccessory>
      ) : null}

      {tabRoutes.map((tab) => (
        <NativeTabs.Trigger key={tab.name} name={tab.name} contentStyle={tabContentStyle}>
          <NativeTabs.Trigger.Icon sf={tab.sf} md={tab.md} />
          <NativeTabs.Trigger.Label>{t(tab.translationKey)}</NativeTabs.Trigger.Label>
          {tab.name === 'alerts' ? (
            <NativeTabs.Trigger.Badge hidden={eventCount === 0}>
              {alertBadge}
            </NativeTabs.Trigger.Badge>
          ) : null}
        </NativeTabs.Trigger>
      ))}
    </NativeTabs>
  );
}

function IOS26FabBar() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const firstSegment = pathname.split('/').filter(Boolean)[0] ?? 'index';
  const routeIndex = tabRoutes.findIndex((tab) => tab.name === firstSegment);
  const selectedIndex = routeIndex < 0 ? 0 : routeIndex;
  const tabs = useMemo(
    () =>
      tabRoutes.map((tab) => ({
        value: tab.name,
        title: t(tab.translationKey),
        systemImage: tab.sf.default,
        selectedSystemImage: tab.sf.selected,
      })),
    [t],
  );

  return (
    <NativeFabTabsView
      tabs={tabs}
      selectedIndex={selectedIndex}
      fabSystemImage="plus"
      fabAccessibilityLabel={t('menu.add')}
      accentColor={colors.primary}
      showFab
      onTabChange={(event) => {
        const destination = tabRoutes[event.nativeEvent.index]?.href;
        if (destination) router.navigate(destination);
      }}
      onFabPress={() => router.push('/add-actions')}
      style={[
        styles.nativeFabBar,
        { bottom: insets.bottom === 0 ? 21 : insets.bottom },
      ]}
    />
  );
}

export default function TabsLayout() {
  const openAlerts = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: () => api.get<Alert[]>('/alerts?state=open'),
  });
  const eventCount = countAlertEvents(openAlerts.data ?? []);

  if (!isIOS26) return <TabNavigator hidden={false} eventCount={eventCount} />;

  return (
    <View style={styles.root}>
      <TabNavigator hidden eventCount={eventCount} />
      <IOS26FabBar />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  nativeFabBar: {
    position: 'absolute',
    left: 21,
    right: 21,
    height: 62,
  },
  addAccessory: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  addAccessoryInline: { gap: 0 },
  addAccessoryPressed: { transform: [{ scale: 0.94 }] },
  addAccessoryText: {
    color: colors.primary,
    fontFamily: fonts.bodySemiBold,
    fontSize: typeScale.bodyLg,
  },
});

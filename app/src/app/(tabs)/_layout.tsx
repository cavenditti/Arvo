// OWNER: shell-nav — Campo tab shell: Fields · Map · [+] · Insights · Me. The raised "+"
// opens a speed-dial (add field / note / photo — PlusMenu); the scouting tab stays
// registered but intercepted. The Insights badge counts grouped alert EVENTS.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Tabs, useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View, type ColorValue } from 'react-native';

import { api } from '@/api/client';
import type { Alert } from '@/api/types';
import PlusMenu from '@/components/PlusMenu';
import { countAlertEvents } from '@/features/insights/grouping';
import { selection } from '@/lib/haptics';
import { GlassSurface } from '@/components/ui';
import { colors, fonts, glass, type as typeScale } from '@/theme';

function TabSymbol({
  symbol,
  fallback,
  color,
  size,
}: {
  symbol: SFSymbol;
  fallback: keyof typeof Ionicons.glyphMap;
  color: ColorValue;
  size: number;
}) {
  return (
    <SymbolView
      name={symbol}
      size={size}
      tintColor={color}
      weight="medium"
      // React Navigation types tab colors as ColorValue; its current renderer supplies strings.
      fallback={<Ionicons name={fallback} color={color as string} size={size} />}
    />
  );
}

export default function TabsLayout() {
  const { t } = useTranslation();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const openAlerts = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: () => api.get<Alert[]>('/alerts?state=open'),
  });
  // Same number the Insights screen shows as cards: events (kind + campo + day),
  // so 12 signals on one parcel badge as 1, not 12.
  const eventCount = countAlertEvents(openAlerts.data ?? []);

  const menuItems = [
    {
      key: 'field',
      icon: 'map-outline' as const,
      label: t('parcel.new_title'),
      onPress: () => router.push('/parcel/new'),
    },
    {
      key: 'note',
      icon: 'create-outline' as const,
      label: t('menu.new_note'),
      onPress: () => router.push('/observation/new?mode=note'),
    },
    {
      key: 'photo',
      icon: 'camera-outline' as const,
      label: t('observation.take_photo_big'),
      onPress: () => router.push('/observation/new?mode=camera'),
    },
  ];

  return (
    <View style={styles.root}>
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textFaint,
          tabBarStyle: styles.tabBar,
          // A real UIKit material sits behind the React Navigation tab buttons on iOS 26;
          // GlassSurface keeps the exact old paper bar on older iOS, Android and web.
          tabBarBackground: () => (
            <GlassSurface style={StyleSheet.absoluteFill} fallbackStyle={styles.tabBarFallback} />
          ),
          tabBarAllowFontScaling: true,
          // Custom label so tab text scales with Dynamic Type but stays capped at maxMult.
          tabBarLabel: ({ color, children }) => (
            <Text
              style={[styles.tabLabel, { color }]}
              allowFontScaling
              maxFontSizeMultiplier={typeScale.maxMult}
              numberOfLines={1}
            >
              {children}
            </Text>
          ),
          headerStyle: styles.header,
          headerTitleStyle: styles.headerTitle,
          headerShadowVisible: false,
          headerTintColor: colors.text,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: t('tabs.dashboard'),
            headerShown: false,
            tabBarIcon: ({ color, size }) => (
              <TabSymbol symbol="square.grid.2x2" fallback="grid-outline" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="map"
          options={{
            title: t('tabs.map'),
            headerShown: false,
            tabBarIcon: ({ color, size }) => (
              <TabSymbol symbol="location.north" fallback="navigate-outline" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="plants"
          options={{
            title: t('tabs.plants'),
            headerShown: false,
            href: null,
            tabBarIcon: ({ color, size }) => (
              <TabSymbol symbol="leaf" fallback="leaf-outline" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="scouting"
          options={{
            // Tab title stays generic; the screen itself is a stub — the FAB below
            // intercepts the press and opens the add menu instead.
            title: t('tabs.scouting'),
            headerShown: false,
            tabBarLabel: () => null,
            tabBarAccessibilityLabel: menuOpen ? t('menu.close') : t('menu.add'),
            tabBarIcon: () => (
              <GlassSurface
                style={styles.fab}
                fallbackStyle={styles.fabFallback}
                tintColor={glass.actionTint}
                isInteractive
              >
                <TabSymbol
                  symbol={menuOpen ? 'xmark' : 'plus'}
                  fallback={menuOpen ? 'close' : 'add'}
                  size={28}
                  color={colors.onPrimary}
                />
              </GlassSurface>
            ),
          }}
          listeners={{
            tabPress: (e) => {
              e.preventDefault();
              selection();
              setMenuOpen((v) => !v);
            },
          }}
        />
        <Tabs.Screen
          name="alerts"
          options={{
            title: t('tabs.alerts'),
            headerShown: false,
            tabBarIcon: ({ color, size }) => (
              <TabSymbol
                symbol="exclamationmark.triangle"
                fallback="warning-outline"
                color={color}
                size={size}
              />
            ),
            tabBarBadge: eventCount > 0 ? eventCount : undefined,
            tabBarBadgeStyle: styles.badge,
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: t('tabs.settings'),
            tabBarIcon: ({ color, size }) => (
              <TabSymbol symbol="person.crop.circle" fallback="person-outline" color={color} size={size} />
            ),
          }}
        />
        {/* Renders its own header; hidden from the bar, reachable via deep link only. */}
        <Tabs.Screen name="weather" options={{ href: null, headerShown: false }} />
      </Tabs>
      <PlusMenu open={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  tabBar: {
    backgroundColor: 'transparent',
    borderTopWidth: 0,
    elevation: 0,
    shadowOpacity: 0,
  },
  tabBarFallback: {
    flex: 1,
    backgroundColor: colors.card,
    borderTopColor: colors.border,
    borderTopWidth: 1,
  },
  tabLabel: { fontSize: 11, fontFamily: fonts.bodySemiBold },
  header: { backgroundColor: colors.bg },
  headerTitle: { color: colors.text, fontFamily: fonts.display },
  badge: {
    backgroundColor: colors.accent,
    color: colors.onPrimary,
    fontSize: 11,
    fontFamily: fonts.bodyBold,
  },
  // Primary action — 52pt, above the touch.min (44) floor.
  fab: {
    width: 52,
    height: 52,
    borderRadius: 26,
    marginTop: -22,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.text,
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
  fabFallback: { backgroundColor: colors.primary, borderColor: colors.card, borderWidth: 3 },
});

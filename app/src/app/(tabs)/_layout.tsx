// OWNER: shell-nav — Arvo's four destinations live in one Liquid Glass navigation pill;
// the primary creation command is a separate, tinted glass control beside it. Tab semantics,
// history and screen mounting remain owned by Expo Router.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Tabs, useRouter } from 'expo-router';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View, type ColorValue } from 'react-native';

import { api } from '@/api/client';
import type { Alert } from '@/api/types';
import { GlassGroup, GlassSurface, InteractivePressable } from '@/components/ui';
import { countAlertEvents } from '@/features/insights/grouping';
import {
  colors,
  fonts,
  glass,
  navigationMetrics,
  radius,
  spacing,
  type as typeScale,
} from '@/theme';

type RouterTabBarProps = Parameters<
  NonNullable<ComponentProps<typeof Tabs>['tabBar']>
>[0];

type TabName = 'index' | 'map' | 'alerts' | 'settings';

type TabItem = {
  name: TabName;
  label: string;
  symbol: SFSymbol;
  selectedSymbol: SFSymbol;
  fallback: keyof typeof Ionicons.glyphMap;
  selectedFallback: keyof typeof Ionicons.glyphMap;
};

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
      fallback={<Ionicons name={fallback} color={color as string} size={size} />}
    />
  );
}

function LiquidGlassTabBar({
  state,
  navigation,
  insets,
  items,
  eventCount,
  addLabel,
  onAdd,
}: RouterTabBarProps & {
  items: TabItem[];
  eventCount: number;
  addLabel: string;
  onAdd: () => void;
}) {
  return (
    <GlassGroup
      glassSpacing={navigationMetrics.controlGap}
      pointerEvents="box-none"
      style={[styles.tabBarHost, { bottom: Math.max(insets.bottom, spacing.sm) }]}
    >
      <GlassSurface
        style={styles.tabsPill}
        fallbackStyle={styles.tabsPillFallback}
        accessibilityRole="tablist"
      >
        {items.map((item) => {
          const routeIndex = state.routes.findIndex((route) => route.name === item.name);
          const route = state.routes[routeIndex];
          if (!route) return null;

          const focused = state.index === routeIndex;
          const color = focused ? colors.primary : colors.textMuted;
          const badge = item.name === 'alerts' && eventCount > 0;

          const tabButton = (
            <InteractivePressable
              haptic
              accessibilityRole="tab"
              accessibilityLabel={item.label}
              accessibilityState={{ selected: focused }}
              onPress={() => {
                const event = navigation.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true,
                });
                if (!focused && !event.defaultPrevented) {
                  navigation.navigate(route.name, route.params);
                }
              }}
              onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
              style={styles.tabItem}
              pressedStyle={styles.tabItemPressed}
            >
              <View style={styles.iconWrap}>
                <TabSymbol
                  symbol={focused ? item.selectedSymbol : item.symbol}
                  fallback={focused ? item.selectedFallback : item.fallback}
                  color={color}
                  size={22}
                />
                {badge ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText} maxFontSizeMultiplier={1}>
                      {eventCount > 99 ? '99+' : eventCount}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text
                style={[styles.tabLabel, { color }]}
                maxFontSizeMultiplier={typeScale.maxMult}
                numberOfLines={1}
              >
                {item.label}
              </Text>
            </InteractivePressable>
          );

          if (!focused) {
            return (
              <View key={route.key} style={styles.tabSlot}>
                {tabButton}
              </View>
            );
          }

          return (
            <GlassSurface
              key={route.key}
              style={styles.selectedTabSurface}
              fallbackStyle={styles.selectedTabFallback}
              tintColor={glass.selectionTint}
              isInteractive
            >
              {tabButton}
            </GlassSurface>
          );
        })}
      </GlassSurface>

      <GlassSurface
        style={styles.actionSurface}
        fallbackStyle={styles.actionSurfaceFallback}
        tintColor={glass.actionTint}
        isInteractive
      >
        <InteractivePressable
          haptic
          accessibilityLabel={addLabel}
          onPress={onAdd}
          style={styles.actionButton}
          pressedStyle={styles.actionPressed}
        >
          <TabSymbol
            symbol="plus"
            fallback="add"
            color={colors.onPrimary}
            size={28}
          />
        </InteractivePressable>
      </GlassSurface>
    </GlassGroup>
  );
}

export default function TabsLayout() {
  const { t } = useTranslation();
  const router = useRouter();
  const openAlerts = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: () => api.get<Alert[]>('/alerts?state=open'),
  });
  const eventCount = countAlertEvents(openAlerts.data ?? []);
  const items: TabItem[] = [
    {
      name: 'index',
      label: t('tabs.dashboard'),
      symbol: 'square.grid.2x2',
      selectedSymbol: 'square.grid.2x2.fill',
      fallback: 'grid-outline',
      selectedFallback: 'grid',
    },
    {
      name: 'map',
      label: t('tabs.map'),
      symbol: 'location.north',
      selectedSymbol: 'location.north.fill',
      fallback: 'navigate-outline',
      selectedFallback: 'navigate',
    },
    {
      name: 'alerts',
      label: t('tabs.alerts'),
      symbol: 'exclamationmark.triangle',
      selectedSymbol: 'exclamationmark.triangle.fill',
      fallback: 'warning-outline',
      selectedFallback: 'warning',
    },
    {
      name: 'settings',
      label: t('tabs.settings'),
      symbol: 'person.crop.circle',
      selectedSymbol: 'person.crop.circle.fill',
      fallback: 'person-circle-outline',
      selectedFallback: 'person-circle',
    },
  ];

  return (
    <Tabs
      tabBar={(props) => (
        <LiquidGlassTabBar
          {...props}
          items={items}
          eventCount={eventCount}
          addLabel={t('menu.add')}
          onAdd={() => router.push('/add-actions')}
        />
      )}
      screenOptions={{
        headerShown: false,
        sceneStyle: styles.scene,
        // The bar is a floating functional layer. Scenes remain edge-to-edge underneath it.
        tabBarStyle: styles.zeroHeightTabBar,
      }}
    >
      <Tabs.Screen name="index" options={{ title: t('tabs.dashboard') }} />
      <Tabs.Screen name="map" options={{ title: t('tabs.map') }} />
      <Tabs.Screen name="alerts" options={{ title: t('tabs.alerts') }} />
      <Tabs.Screen name="settings" options={{ title: t('tabs.settings') }} />
      <Tabs.Screen name="plants" options={{ href: null }} />
      <Tabs.Screen name="scouting" options={{ href: null }} />
      <Tabs.Screen name="weather" options={{ href: null }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  scene: { backgroundColor: colors.bg },
  zeroHeightTabBar: { height: 0, position: 'absolute' },
  tabBarHost: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    height: navigationMetrics.barHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    zIndex: 100,
    elevation: 20,
  },
  tabsPill: {
    flex: 1,
    height: navigationMetrics.barHeight,
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: radius.pill,
    padding: 4,
    overflow: 'hidden',
  },
  tabsPillFallback: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tabSlot: {
    flex: 1,
    minWidth: 44,
    minHeight: 56,
  },
  selectedTabSurface: {
    flex: 1,
    minWidth: 44,
    minHeight: 56,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  selectedTabFallback: {
    backgroundColor: glass.selectionTint,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  tabItemPressed: { transform: [{ scale: 0.96 }] },
  iconWrap: { width: 34, height: 25, alignItems: 'center', justifyContent: 'center' },
  tabLabel: { fontFamily: fonts.bodySemiBold, fontSize: 10 },
  badge: {
    position: 'absolute',
    top: -3,
    right: -6,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  badgeText: { color: colors.onPrimary, fontFamily: fonts.bodyBold, fontSize: 9 },
  actionSurface: {
    width: navigationMetrics.barHeight,
    height: navigationMetrics.barHeight,
    borderRadius: navigationMetrics.barHeight / 2,
    overflow: 'hidden',
  },
  actionSurfaceFallback: {
    backgroundColor: colors.primary,
    borderColor: colors.primaryDark,
    borderWidth: StyleSheet.hairlineWidth,
  },
  actionButton: {
    width: navigationMetrics.barHeight,
    height: navigationMetrics.barHeight,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: navigationMetrics.barHeight / 2,
  },
  actionPressed: { transform: [{ scale: 0.9 }] },
});

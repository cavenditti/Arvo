// OWNER: shell-nav — Campo tab shell: Fields · Map · [+] · Insights · Me. The raised "+"
// opens the capture flow directly (the scouting tab stays registered but is intercepted);
// the Insights badge counts grouped alert EVENTS, not raw signal volume.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { Tabs, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { api } from '@/api/client';
import type { Alert } from '@/api/types';
import { countAlertEvents } from '@/features/insights/grouping';
import { colors, fonts, type as typeScale } from '@/theme';

export default function TabsLayout() {
  const { t } = useTranslation();
  const router = useRouter();
  const openAlerts = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: () => api.get<Alert[]>('/alerts?state=open'),
  });
  // Same number the Insights screen shows as cards: events (kind + campo + day),
  // so 12 signals on one parcel badge as 1, not 12.
  const eventCount = countAlertEvents(openAlerts.data ?? []);

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: styles.tabBar,
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
          tabBarIcon: ({ color, size }) => <Ionicons name="grid-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="map"
        options={{
          title: t('tabs.map'),
          headerShown: false,
          tabBarIcon: ({ color, size }) => <Ionicons name="navigate-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="plants"
        options={{
          title: t('tabs.plants'),
          headerShown: false,
          href: null,
          tabBarIcon: ({ color, size }) => <Ionicons name="leaf-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="scouting"
        options={{
          // Tab title stays generic; the screen itself is a stub — the FAB below
          // intercepts the press and opens capture directly.
          title: t('tabs.scouting'),
          headerShown: false,
          tabBarLabel: () => null,
          tabBarAccessibilityLabel: t('tabs.new_observation', { defaultValue: 'Nuovo rilievo' }),
          tabBarIcon: () => (
            <View style={styles.fab}>
              <Ionicons name="add" size={28} color={colors.onPrimary} />
            </View>
          ),
        }}
        listeners={{
          tabPress: (e) => {
            e.preventDefault();
            router.push('/observation/new');
          },
        }}
      />
      <Tabs.Screen
        name="alerts"
        options={{
          title: t('tabs.alerts'),
          headerShown: false,
          tabBarIcon: ({ color, size }) => <Ionicons name="warning-outline" color={color} size={size} />,
          tabBarBadge: eventCount > 0 ? eventCount : undefined,
          tabBarBadgeStyle: styles.badge,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
          tabBarIcon: ({ color, size }) => <Ionicons name="person-outline" color={color} size={size} />,
        }}
      />
      {/* Renders its own header; hidden from the bar, reachable via deep link only. */}
      <Tabs.Screen name="weather" options={{ href: null, headerShown: false }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
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
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: colors.card,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
});

// SPINE — Campo tab shell: Fields · Map · [Scout +] · Insights · Me, raised center FAB,
// open-alert badge on Insights. Screens with custom headers opt out via headerShown:false.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { api } from '@/api/client';
import type { Alert } from '@/api/types';
import { colors } from '@/theme';

export default function TabsLayout() {
  const { t } = useTranslation();
  const openAlerts = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: () => api.get<Alert[]>('/alerts?state=open'),
  });
  const openCount = openAlerts.data?.length ?? 0;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: styles.tabBar,
        tabBarLabelStyle: styles.tabLabel,
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
        name="scouting"
        options={{
          title: t('tabs.scouting'),
          tabBarLabel: () => null,
          tabBarIcon: () => (
            <View style={styles.fab}>
              <Ionicons name="add" size={28} color={colors.onPrimary} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="alerts"
        options={{
          title: t('tabs.alerts'),
          headerShown: false,
          tabBarIcon: ({ color, size }) => <Ionicons name="warning-outline" color={color} size={size} />,
          tabBarBadge: openCount > 0 ? openCount : undefined,
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
      {/* web-portal page; reachable on native only via deep link, never as a tab */}
      <Tabs.Screen name="weather" options={{ href: null }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.card,
    borderTopColor: colors.border,
    borderTopWidth: 1,
  },
  tabLabel: { fontSize: 11, fontWeight: '600' },
  header: { backgroundColor: colors.bg },
  headerTitle: { color: colors.text, fontWeight: '700' },
  badge: {
    backgroundColor: colors.accent,
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
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

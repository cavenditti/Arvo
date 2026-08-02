// OWNER: shell-nav — Arvo's four primary destinations use the platform tab bar directly.
// On iOS 26 UIKit owns the Liquid Glass shape, hover, selection, and minimize behavior;
// Expo Router continues to own tab history and screen mounting.
import { useQuery } from '@tanstack/react-query';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useTranslation } from 'react-i18next';

import { api } from '@/api/client';
import type { Alert } from '@/api/types';
import { countAlertEvents } from '@/features/insights/grouping';
import { colors } from '@/theme';

const tabContentStyle = { backgroundColor: colors.bg } as const;

export default function TabsLayout() {
  const { t } = useTranslation();
  const openAlerts = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: () => api.get<Alert[]>('/alerts?state=open'),
  });
  const eventCount = countAlertEvents(openAlerts.data ?? []);
  const alertBadge = eventCount > 99 ? '99+' : String(eventCount);

  return (
    <NativeTabs
      backBehavior="history"
      badgeBackgroundColor={colors.accent}
      minimizeBehavior="automatic"
      tintColor={colors.primary}
    >
      <NativeTabs.Trigger name="index" contentStyle={tabContentStyle}>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'square.grid.2x2', selected: 'square.grid.2x2.fill' }}
          md="dashboard"
        />
        <NativeTabs.Trigger.Label>{t('tabs.dashboard')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="map" contentStyle={tabContentStyle}>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'location.north', selected: 'location.north.fill' }}
          md="navigation"
        />
        <NativeTabs.Trigger.Label>{t('tabs.map')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="alerts" contentStyle={tabContentStyle}>
        <NativeTabs.Trigger.Icon
          sf={{
            default: 'exclamationmark.triangle',
            selected: 'exclamationmark.triangle.fill',
          }}
          md="warning"
        />
        <NativeTabs.Trigger.Label>{t('tabs.alerts')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={eventCount === 0}>
          {alertBadge}
        </NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="settings" contentStyle={tabContentStyle}>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }}
          md="account_circle"
        />
        <NativeTabs.Trigger.Label>{t('tabs.settings')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

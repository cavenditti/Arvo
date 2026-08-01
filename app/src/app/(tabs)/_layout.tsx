// OWNER: shell-nav — Native tab shell. On iOS 26 UIKit renders the Liquid Glass bar and
// selection capsule; Arvo contributes only its forest tint, labels and native symbols.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet } from 'react-native';

import { api } from '@/api/client';
import type { Alert } from '@/api/types';
import { countAlertEvents } from '@/features/insights/grouping';
import { selection } from '@/lib/haptics';
import { colors, fonts } from '@/theme';

export default function TabsLayout() {
  const { t } = useTranslation();
  const router = useRouter();
  const openAlerts = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: () => api.get<Alert[]>('/alerts?state=open'),
  });
  const eventCount = countAlertEvents(openAlerts.data ?? []);

  return (
    <NativeTabs
      tintColor={colors.primary}
      iconColor={{ default: colors.textFaint, selected: colors.primary }}
      labelStyle={{
        default: styles.label,
        selected: styles.selectedLabel,
      }}
      badgeBackgroundColor={colors.accent}
      badgeTextColor={colors.onPrimary}
      indicatorColor={colors.primarySoft}
      rippleColor={colors.primarySoft}
      backgroundColor={Platform.OS === 'android' ? colors.card : undefined}
      minimizeBehavior="onScrollDown"
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>{t('tabs.dashboard')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'square.grid.2x2', selected: 'square.grid.2x2.fill' }}
          src={{
            default: <NativeTabs.Trigger.VectorIcon family={Ionicons} name="grid-outline" />,
            selected: <NativeTabs.Trigger.VectorIcon family={Ionicons} name="grid" />,
          }}
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="map">
        <NativeTabs.Trigger.Label>{t('tabs.map')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'location.north', selected: 'location.north.fill' }}
          src={{
            default: <NativeTabs.Trigger.VectorIcon family={Ionicons} name="navigate-outline" />,
            selected: <NativeTabs.Trigger.VectorIcon family={Ionicons} name="navigate" />,
          }}
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger
        name="scouting"
        disabled
        accessibilityLabel={t('menu.add')}
        listeners={{
          tabPress: () => {
            selection();
            router.push('/add-actions');
          },
        }}
      >
        <NativeTabs.Trigger.Label hidden>{t('menu.add')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf="plus.circle.fill"
          src={<NativeTabs.Trigger.VectorIcon family={Ionicons} name="add-circle" />}
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="alerts">
        <NativeTabs.Trigger.Label>{t('tabs.alerts')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{
            default: 'exclamationmark.triangle',
            selected: 'exclamationmark.triangle.fill',
          }}
          src={{
            default: <NativeTabs.Trigger.VectorIcon family={Ionicons} name="warning-outline" />,
            selected: <NativeTabs.Trigger.VectorIcon family={Ionicons} name="warning" />,
          }}
        />
        <NativeTabs.Trigger.Badge hidden={eventCount === 0}>
          {eventCount > 0 ? String(eventCount) : undefined}
        </NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>{t('tabs.settings')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }}
          src={{
            default: (
              <NativeTabs.Trigger.VectorIcon family={Ionicons} name="person-circle-outline" />
            ),
            selected: <NativeTabs.Trigger.VectorIcon family={Ionicons} name="person-circle" />,
          }}
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

const styles = StyleSheet.create({
  label: {
    color: colors.textFaint,
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
  },
  selectedLabel: {
    color: colors.primary,
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
  },
});

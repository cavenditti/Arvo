// OWNER: shell-nav — Arvo's four primary destinations use the platform tab bar directly.
// On iOS 26 UIKit owns the Liquid Glass shape, hover, selection, and minimize behavior;
// Expo Router continues to own tab history and screen mounting. Creation lives in UIKit's
// bottom accessory so it stays thumb-reachable and adapts beside the minimized tab bar.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text } from 'react-native';

import { api } from '@/api/client';
import type { Alert } from '@/api/types';
import { InteractivePressable } from '@/components/ui';
import { countAlertEvents } from '@/features/insights/grouping';
import { colors, fonts, spacing, type as typeScale } from '@/theme';

const tabContentStyle = { backgroundColor: colors.bg } as const;

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
      <NativeTabs.BottomAccessory>
        <AddAccessory />
      </NativeTabs.BottomAccessory>

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

const styles = StyleSheet.create({
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

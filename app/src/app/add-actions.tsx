import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { InteractivePressable } from '@/components/ui';
import { colors, fonts, radius, spacing, touch, type as typeScale } from '@/theme';

export default function AddActionsScreen() {
  const { t } = useTranslation();
  const router = useRouter();

  const actions = [
    {
      key: 'field',
      icon: 'map-outline' as const,
      label: t('parcel.new_title'),
      href: '/parcel/new' as const,
    },
    {
      key: 'note',
      icon: 'create-outline' as const,
      label: t('menu.new_note'),
      href: '/observation/new?mode=note' as const,
    },
    {
      key: 'photo',
      icon: 'camera-outline' as const,
      label: t('observation.take_photo_big'),
      href: '/observation/new?mode=camera' as const,
    },
  ];

  return (
    <View style={styles.screen}>
      <Text style={styles.title} maxFontSizeMultiplier={typeScale.maxMult}>
        {t('menu.add')}
      </Text>
      {actions.map((action) => (
        <InteractivePressable
          key={action.key}
          haptic
          onPress={() => router.replace(action.href)}
          accessibilityLabel={action.label}
          style={styles.row}
          pressedStyle={styles.rowPressed}
        >
          <View style={styles.icon}>
            <Ionicons name={action.icon} size={22} color={colors.primary} />
          </View>
          <Text style={styles.label} maxFontSizeMultiplier={typeScale.maxMult}>
            {action.label}
          </Text>
          <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
        </InteractivePressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.bg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  title: {
    color: colors.text,
    fontFamily: fonts.display,
    fontSize: typeScale.title,
    textAlign: 'center',
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs,
  },
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  rowPressed: { transform: [{ scale: 0.985 }] },
  icon: {
    width: touch.min,
    height: touch.min,
    borderRadius: touch.min / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  label: {
    flex: 1,
    color: colors.text,
    fontFamily: fonts.bodySemiBold,
    fontSize: typeScale.bodyLg,
  },
});

import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { InteractivePressable } from '@/components/ui';
import { colors, fonts, radius, spacing } from '@/theme';

type FieldView = 'overview' | 'plants';

/** Keeps every field-level surface inside one clear Overview / Plants workspace. */
export default function FieldViewSwitcher({
  parcelId,
  active,
}: {
  parcelId: string;
  active: FieldView;
}) {
  const { t } = useTranslation();
  const router = useRouter();

  const items: {
    key: FieldView;
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
    onPress: () => void;
  }[] = [
    {
      key: 'overview',
      label: t('fields.overview'),
      icon: 'pulse-outline',
      onPress: () => router.push(`/parcel/${parcelId}`),
    },
    {
      key: 'plants',
      label: t('tabs.plants'),
      icon: 'leaf-outline',
      onPress: () => router.push({ pathname: '/plants', params: { parcelId } }),
    },
  ];

  return (
    <View style={styles.track} accessibilityRole="tablist">
      {items.map((item) => {
        const selected = item.key === active;
        return (
          <InteractivePressable
            key={item.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={item.onPress}
            style={[styles.item, selected && styles.itemActive]}
            hoverStyle={!selected ? styles.itemHover : undefined}
          >
            <Ionicons
              name={item.icon}
              size={15}
              color={selected ? colors.onPrimary : colors.textMuted}
            />
            <Text style={[styles.label, selected && styles.labelActive]}>{item.label}</Text>
          </InteractivePressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 3,
    padding: 3,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardAlt,
  },
  item: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
  },
  itemActive: { backgroundColor: colors.primary },
  itemHover: { backgroundColor: colors.card },
  label: { fontFamily: fonts.bodySemiBold, fontSize: 12.5, color: colors.textMuted },
  labelActive: { color: colors.onPrimary },
});

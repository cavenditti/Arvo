// Speed-dial for the raised "+" tab button: one place to add anything (field, note,
// photo). Owned by the tab shell; rendered as an absolute overlay above the whole tab
// navigator so the scrim covers content AND the bar. Animated with core RN only.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { selection } from '@/lib/haptics';
import { colors, fonts, radius, spacing, touch, type as typeScale } from '@/theme';

export interface PlusMenuItem {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  items: PlusMenuItem[];
}

/** Bottom clearance so the first item sits just above the raised FAB. */
const FAB_CLEARANCE = 96;

export default function PlusMenu({ open, onClose, items }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  // Lazy state, not a ref: created once, read during render (same pattern as Toast).
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: 160,
      easing: open ? Easing.out(Easing.quad) : Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [open, progress]);

  // Keep mounted while animating out; pointerEvents gates interaction.
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents={open ? 'auto' : 'none'}
      accessibilityViewIsModal={open}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? 'yes' : 'no-hide-descendants'}
    >
      <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: progress }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('menu.close')}
        />
      </Animated.View>
      <View
        pointerEvents="box-none"
        style={[styles.stack, { bottom: insets.bottom + FAB_CLEARANCE }]}
      >
        {items.map((item, i) => {
          // Later items sit higher and arrive a touch later — a quiet cascade.
          const translateY = progress.interpolate({
            inputRange: [0, 1],
            outputRange: [12 * (items.length - i), 0],
          });
          return (
            <Animated.View
              key={item.key}
              style={{ opacity: progress, transform: [{ translateY }] }}
            >
              <Pressable
                onPress={() => {
                  selection();
                  onClose();
                  item.onPress();
                }}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <Text
                  style={styles.label}
                  allowFontScaling
                  maxFontSizeMultiplier={typeScale.maxMult}
                >
                  {item.label}
                </Text>
                <View style={styles.iconDisc}>
                  <Ionicons name={item.icon} size={22} color={colors.onPrimary} />
                </View>
              </Pressable>
            </Animated.View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: 'rgba(28, 34, 28, 0.42)' },
  stack: {
    position: 'absolute',
    right: spacing.md,
    left: spacing.md,
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: touch.min,
  },
  rowPressed: { opacity: 0.85 },
  label: {
    backgroundColor: colors.card,
    color: colors.text,
    fontFamily: fonts.bodySemiBold,
    fontSize: typeScale.body,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  iconDisc: {
    width: touch.min,
    height: touch.min,
    borderRadius: touch.min / 2,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.card,
  },
});

// OWNER: fe-plant-map — Non-iOS fallback for the native plant-ranking bottom drawer.
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { GlassSurface } from '@/components/ui';
import { colors, radius, spacing } from '@/theme';

export const PLANT_LIST_DRAWER_COMPACT_HEIGHT = 300;

type PlantListDrawerProps = {
  children: ReactNode;
  presented: boolean;
  bottomOffset?: number;
};

export default function PlantListDrawer({
  children,
  presented,
  bottomOffset = 0,
}: PlantListDrawerProps) {
  if (!presented) return null;

  return (
    <GlassSurface
      style={[styles.drawer, { bottom: bottomOffset }]}
      fallbackStyle={[styles.drawer, styles.fallback]}
    >
      <View style={styles.grabber} />
      <View style={styles.content}>{children}</View>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  drawer: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: PLANT_LIST_DRAWER_COMPACT_HEIGHT,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    overflow: 'hidden',
    zIndex: 20,
    elevation: 12,
  },
  fallback: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 5,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.textFaint,
  },
  content: { flex: 1 },
});

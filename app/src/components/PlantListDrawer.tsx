// OWNER: fe-plant-map — Non-iOS fallback for the native plant-ranking bottom drawer.
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { GlassSurface } from '@/components/ui';
import { colors, radius, spacing } from '@/theme';

export const PLANT_LIST_DRAWER_COMPACT_HEIGHT = 150;

type PlantListDrawerProps = {
  children: (expanded: boolean) => ReactNode;
  presented: boolean;
  bottomOffset?: number;
};

export default function PlantListDrawer({
  children,
  presented,
  bottomOffset = 0,
}: PlantListDrawerProps) {
  const [expanded, setExpanded] = useState(false);
  if (!presented) return null;

  return (
    <GlassSurface
      style={[styles.drawer, expanded && styles.drawerExpanded, { bottom: bottomOffset }]}
      fallbackStyle={[styles.drawer, styles.fallback]}
    >
      <Pressable
        onPress={() => setExpanded((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        style={styles.grabberTouch}
      >
        <View style={styles.grabber} />
      </Pressable>
      <View style={styles.content}>{children(expanded)}</View>
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
  drawerExpanded: { height: '80%' },
  fallback: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  grabber: {
    width: 36,
    height: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.textFaint,
  },
  grabberTouch: {
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xs,
  },
  content: { flex: 1 },
});

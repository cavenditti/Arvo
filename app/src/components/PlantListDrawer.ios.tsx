// OWNER: fe-plant-map — Native iOS bottom drawer for plant rankings. SwiftUI owns the sheet
// geometry and drag interaction; React Native owns the existing Terra content inside it.
import { useMemo, type ReactNode } from 'react';
import { StyleSheet, useColorScheme, useWindowDimensions, View } from 'react-native';

import { BottomSheet, Group, Host, RNHostView } from '@expo/ui/swift-ui';
import {
  interactiveDismissDisabled,
  presentationBackground,
  presentationBackgroundInteraction,
  presentationDetents,
  presentationDragIndicator,
  type PresentationDetent,
} from '@expo/ui/swift-ui/modifiers';

import { GlassSurface, hasNativeLiquidGlass } from '@/components/ui';

export const PLANT_LIST_DRAWER_COMPACT_HEIGHT = 300;

const COMPACT_DETENT: PresentationDetent = { height: PLANT_LIST_DRAWER_COMPACT_HEIGHT };
const DRAWER_DETENTS: PresentationDetent[] = [COMPACT_DETENT, 'large'];

type PlantListDrawerProps = {
  children: ReactNode;
  presented: boolean;
  /** Used by the cross-platform fallback; native iOS sheets always attach to the screen bottom. */
  bottomOffset?: number;
};

export default function PlantListDrawer({ children, presented }: PlantListDrawerProps) {
  const { width } = useWindowDimensions();
  const colorScheme = useColorScheme();
  const liquidGlass = hasNativeLiquidGlass();

  const modifiers = useMemo(
    () => [
      presentationDetents(DRAWER_DETENTS),
      presentationDragIndicator('visible'),
      interactiveDismissDisabled(true),
      presentationBackgroundInteraction({ type: 'enabledUpThrough', detent: COMPACT_DETENT }),
      // Liquid Glass needs the map behind the React Native surface. Older systems receive the
      // same opaque Terra card colour that the former floating panel used.
      presentationBackground(
        liquidGlass ? '#00000000' : colorScheme === 'dark' ? '#181D18' : '#FBFAF7',
      ),
    ],
    [colorScheme, liquidGlass],
  );

  return (
    <Host style={[styles.host, { width }]} pointerEvents="none">
      <BottomSheet
        isPresented={presented}
        onIsPresentedChange={() => {
          // The drawer is deliberately persistent while this route is focused.
        }}
      >
        <Group modifiers={modifiers}>
          <RNHostView>
            <View style={styles.contentHost}>
              <GlassSurface style={styles.surface} fallbackStyle={styles.fallbackSurface}>
                {children}
              </GlassSurface>
            </View>
          </RNHostView>
        </Group>
      </BottomSheet>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute' },
  // height: 0 supplies a zero flex basis; flexGrow then fills the selected native detent.
  contentHost: { flexGrow: 1, height: 0, paddingTop: 16 },
  surface: { flex: 1 },
  fallbackSurface: { backgroundColor: 'transparent' },
});

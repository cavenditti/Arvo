import type { ReactNode } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, spacing } from '@/theme';

interface NativeSheetProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  closeAccessibilityLabel: string;
}

/**
 * A native, swipe-dismissable page sheet on iOS. Other platforms keep the familiar
 * bottom-sheet presentation and explicit backdrop dismissal.
 */
export default function NativeSheet({
  visible,
  onClose,
  children,
  contentStyle,
  closeAccessibilityLabel,
}: NativeSheetProps) {
  const insets = useSafeAreaInsets();
  const ios = Platform.OS === 'ios';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={!ios}
      presentationStyle={ios ? 'pageSheet' : 'overFullScreen'}
      allowSwipeDismissal={ios}
      onRequestClose={onClose}
    >
      {ios ? (
        <View
          style={[
            styles.iosContent,
            { paddingBottom: insets.bottom + spacing.md },
            contentStyle,
          ]}
        >
          {children}
        </View>
      ) : (
        <View style={styles.androidRoot}>
          <Pressable
            style={styles.backdrop}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={closeAccessibilityLabel}
          />
          <View
            style={[
              styles.androidContent,
              { paddingBottom: insets.bottom + spacing.md },
              contentStyle,
            ]}
          >
            {children}
          </View>
        </View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  iosContent: {
    flex: 1,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  androidRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(27, 30, 26, 0.35)',
  },
  androidContent: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
});

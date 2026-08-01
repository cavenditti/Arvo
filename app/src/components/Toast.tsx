// OWNER: foundation-ui — bottom toast (docs/UX-REVAMP.md frozen contract, docs/DESIGN.md §Toasts).
// One ToastHost mounted once in the root layout; everything else calls useToast()/showToast().
// Quiet confirmation voice: a short pill above the tab bar, auto-dismissed, never blocking.
import type { JSX } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, severityTint, spacing, type as typeScale } from '@/theme';

export type ToastKind = 'success' | 'info' | 'error';

export interface ToastOptions {
  message: string;
  kind?: ToastKind;
}

type ToastListener = (toast: ToastOptions) => void;

// One module-level emitter shared by the hook, the imperative call and the host.
let hostListener: ToastListener | null = null;

/** Imperative toast — safe to call anywhere (mutations, sync code). No-op until a host mounts. */
export function showToast(o: ToastOptions): void {
  hostListener?.(o);
}

/** Hook flavor of the same emitter, for components. */
export function useToast(): { show(o: ToastOptions): void } {
  return useMemo(() => ({ show: showToast }), []);
}

const KIND_TINT: Record<ToastKind, { fg: string; bg: string }> = {
  success: { fg: colors.primaryDark, bg: colors.primarySoft },
  error: { fg: severityTint.critical.fg, bg: severityTint.critical.bg },
  info: { fg: colors.text, bg: colors.cardAlt },
};

const SHOW_MS = 2500;
const FADE_MS = 180;
// Clearance for the tab bar (~56pt) plus a breathing margin, added to the safe-area inset.
const TAB_BAR_CLEARANCE = 72;

/** Mounted once (root layout). Renders nothing while no toast is active. */
export function ToastHost(): JSX.Element {
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<ToastOptions | null>(null);
  // Lazy state, not a ref: the Animated.Value is created once and may be read during render.
  const [anim] = useState(() => new Animated.Value(0));
  const [translate] = useState(() =>
    anim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }),
  );
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handle: ToastListener = (next) => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setToast(next);
      Animated.timing(anim, {
        toValue: 1,
        duration: FADE_MS,
        easing: Easing.out(Easing.ease),
        useNativeDriver: Platform.OS !== 'web',
      }).start();
      hideTimer.current = setTimeout(() => {
        Animated.timing(anim, {
          toValue: 0,
          duration: FADE_MS,
          easing: Easing.in(Easing.ease),
          useNativeDriver: Platform.OS !== 'web',
        }).start(({ finished }) => {
          if (finished) setToast(null);
        });
      }, SHOW_MS);
    };
    hostListener = handle;
    return () => {
      if (hostListener === handle) hostListener = null;
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [anim]);

  const tint = KIND_TINT[toast?.kind ?? 'info'];

  return (
    <View
      pointerEvents="none"
      style={[styles.host, { bottom: insets.bottom + TAB_BAR_CLEARANCE }]}
    >
      {toast != null && (
        <Animated.View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={[
            styles.pill,
            { backgroundColor: tint.bg },
            { opacity: anim, transform: [{ translateY: translate }] },
          ]}
        >
          <Text
            style={[styles.text, { color: tint.fg }]}
            maxFontSizeMultiplier={typeScale.maxMult}
            numberOfLines={2}
          >
            {toast.message}
          </Text>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    alignItems: 'center',
    zIndex: 100,
  },
  pill: {
    maxWidth: 520,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    // Floating element — soft shadow allowed (docs/DESIGN.md §4).
    shadowColor: '#1B1E1A',
    shadowOpacity: 0.14,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  text: {
    fontFamily: fonts.bodySemiBold,
    fontSize: typeScale.body,
    textAlign: 'center',
  },
});

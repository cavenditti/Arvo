// OWNER: shell-nav — app shell: branded splash, offline-persisted QueryClient, auth gate,
// toast host, push bootstrap, and the one Stack that names every screen. The native splash
// stays up until fonts AND auth restore finish, so cold boot never shows a bare spinner.
import { Fraunces_600SemiBold, Fraunces_700Bold } from '@expo-google-fonts/fraunces';
import { IBMPlexMono_400Regular, IBMPlexMono_600SemiBold } from '@expo-google-fonts/ibm-plex-mono';
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
} from '@expo-google-fonts/manrope';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';

import { AuthProvider, useAuth } from '@/auth/AuthContext';
import Logo from '@/components/Logo';
import { ToastHost } from '@/components/Toast';
import '@/i18n';
import { setupNotifications } from '@/notifications/push';
import { queryPersistOptions } from '@/offline/persist';
import { colors, fonts, spacing, type as typeScale } from '@/theme';

// Hold the native splash (configured in app.json) until the shell is ready. No-op on web.
void SplashScreen.preventAutoHideAsync().catch(() => {});

// Notification handler + iOS categories, once per JS load. Guarded: push must never
// take down the shell (Expo Go, missing EAS project id, web).
try {
  setupNotifications();
} catch {
  // Best-effort — the app simply runs without push.
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  },
});

/** Branded boot view (paper + mark), replacing the old anonymous white spinner. The
 * wordmark is skipped while fonts are still loading so we never render an unregistered
 * font family. Mostly invisible on native (behind the splash image) — web sees it. */
function BootScreen({ wordmark = true }: { wordmark?: boolean }) {
  return (
    <View style={styles.boot}>
      <Logo size={64} variant="plain" />
      {wordmark && (
        <Text style={styles.bootWordmark} maxFontSizeMultiplier={typeScale.maxMult}>
          Arvo
        </Text>
      )}
      <ActivityIndicator size="small" color={colors.primary} />
    </View>
  );
}

// Screens reachable while signed out: the auth flow plus the legal pages linked from it.
const PUBLIC_SEGMENTS = new Set(['login', 'register', 'forgot-password', 'legal']);

function RootNavigator() {
  const { status, token } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const { t } = useTranslation();

  useEffect(() => {
    if (status === 'restoring') return;
    const first = segments[0] ?? '';
    if (!token && !PUBLIC_SEGMENTS.has(first)) router.replace('/login');
    else if (token && (first === 'login' || first === 'register')) router.replace('/');
  }, [status, token, segments, router]);

  // Fonts are ready by the time this mounts (RootLayout gates on them); once auth restore
  // settles the first real frame is up — drop the native splash.
  useEffect(() => {
    if (status !== 'restoring') void SplashScreen.hideAsync().catch(() => {});
  }, [status]);

  if (status === 'restoring') return <BootScreen />;

  const closeCreationModal = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const creationModalHeaderLeft = () => (
    <Pressable
      onPress={closeCreationModal}
      accessibilityRole="button"
      accessibilityLabel={t('common.cancel')}
      hitSlop={8}
      style={styles.modalCancel}
    >
      <Text style={styles.modalCancelText} maxFontSizeMultiplier={typeScale.maxMult}>
        {t('common.cancel')}
      </Text>
    </Pressable>
  );

  return (
    <Stack
      screenOptions={{
        // 'minimal' keeps the chevron but drops the previous screen's title —
        // kills the "(tabs)" back label (SDK 57 native-stack option).
        headerBackButtonDisplayMode: 'minimal',
        headerTintColor: colors.text,
        // Leave iOS entirely to UIKit (including SF title typography and its system material).
        // Non-iOS retains the Terra paper treatment.
        ...(Platform.OS === 'ios'
          ? {}
          : {
              headerStyle: { backgroundColor: colors.bg },
              headerTitleStyle: { fontFamily: fonts.display, color: colors.text },
            }),
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
        gestureEnabled: true,
        fullScreenGestureEnabled: Platform.OS === 'ios',
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="register" options={{ title: t('auth.register_title') }} />
      <Stack.Screen name="forgot-password" options={{ title: t('auth.reset_title') }} />
      <Stack.Screen name="legal/privacy" options={{ title: t('auth.legal_privacy') }} />
      <Stack.Screen name="legal/terms" options={{ title: t('auth.legal_terms') }} />
      <Stack.Screen name="security" options={{ title: t('settings.security') }} />
      <Stack.Screen name="scouting" options={{ title: t('scouting.open_list') }} />
      <Stack.Screen name="weather-details" options={{ title: t('weather.title') }} />
      <Stack.Screen
        name="plant-map"
        options={{ title: t('plantmap.title'), headerTransparent: Platform.OS === 'ios' }}
      />
      <Stack.Screen
        name="add-actions"
        options={{
          headerShown: false,
          presentation: 'formSheet',
          sheetAllowedDetents: 'fitToContents',
          sheetGrabberVisible: true,
        }}
      />
      {/* Detail screens set their real title from data; empty beats a route-name flash. */}
      <Stack.Screen name="parcel/[id]" options={{ title: '' }} />
      <Stack.Screen name="plant/[id]" options={{ title: '' }} />
      {/* Creation flows present as iOS sheets; each screen refines its own title. */}
      <Stack.Screen
        name="parcel/new"
        options={{
          presentation: 'modal',
          title: t('parcel.new_title'),
          headerLeft: creationModalHeaderLeft,
        }}
      />
      <Stack.Screen
        name="observation/new"
        options={{
          presentation: 'modal',
          title: t('observation.new_title'),
          headerLeft: creationModalHeaderLeft,
        }}
      />
      <Stack.Screen
        name="capture/new"
        options={{
          presentation: 'modal',
          title: t('capture.new_title'),
          headerLeft: creationModalHeaderLeft,
        }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  // Subscribe once at the shell. Native semantic colors update in place on iOS, while this
  // guarantees navigation and Android system surfaces re-evaluate when appearance changes.
  useColorScheme();

  // Terra voices (docs/DESIGN.md §3). On a load error we render anyway — RN falls
  // back to system fonts rather than blanking the app.
  const [fontsLoaded, fontsError] = useFonts({
    Fraunces_600SemiBold,
    Fraunces_700Bold,
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    IBMPlexMono_400Regular,
    IBMPlexMono_600SemiBold,
  });

  if (!fontsLoaded && !fontsError) {
    return <BootScreen wordmark={false} />;
  }

  return (
    <View style={styles.root}>
      <StatusBar style="auto" />
      <PersistQueryClientProvider client={queryClient} persistOptions={queryPersistOptions}>
        <AuthProvider>
          <RootNavigator />
          <ToastHost />
        </AuthProvider>
      </PersistQueryClientProvider>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    ...(Platform.OS === 'web' ? ({ colorScheme: 'light dark' } as object) : {}),
  },
  boot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    backgroundColor: colors.bg,
  },
  bootWordmark: {
    fontFamily: fonts.display,
    fontSize: typeScale.titleLg,
    color: colors.text,
  },
  modalCancel: {
    minHeight: 44,
    justifyContent: 'center',
    paddingRight: spacing.sm,
  },
  modalCancelText: {
    color: colors.primary,
    fontFamily: fonts.bodySemiBold,
    fontSize: typeScale.body,
  },
});

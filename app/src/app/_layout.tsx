// OWNER: fe-shell — add AuthProvider (token restore from secure storage, redirect to /login when
// unauthenticated), locale bootstrap, and headers. Keep QueryClientProvider + i18n import.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';

import '../i18n';

const queryClient = new QueryClient();

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="register" options={{ headerShown: false }} />
      </Stack>
    </QueryClientProvider>
  );
}

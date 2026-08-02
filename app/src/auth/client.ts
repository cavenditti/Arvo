import { expoClient } from '@better-auth/expo/client';
import * as SecureStore from 'expo-secure-store';
import { createAuthClient } from 'better-auth/react';
import {
  inferAdditionalFields,
  jwtClient,
  organizationClient,
} from 'better-auth/client/plugins';
import { Platform } from 'react-native';

import { ApiError } from '@/api/client';

export const AUTH_URL = process.env.EXPO_PUBLIC_AUTH_URL ?? 'http://localhost:3000';

// TypeScript 6 (required by Expo 57) currently rejects Better Auth's plugin fetch generics even
// when every package resolves to the same 1.6.x core. Keep the cast at this boundary; the small
// runtime extension below restores the public methods we use without weakening the app at large.
const rawAuthClient = createAuthClient({
  baseURL: AUTH_URL,
  plugins: [
    inferAdditionalFields({
      user: {
        locale: {
          type: 'string',
          required: false,
          defaultValue: 'it',
        },
      },
    }) as never,
    organizationClient() as never,
    jwtClient() as never,
    expoClient({
      scheme: 'arvo',
      storagePrefix: 'arvo',
      storage: SecureStore,
    }) as never,
  ],
});

type BetterAuthError = {
  code?: string;
  message?: string;
  status?: number;
  statusText?: string;
};

type ClientResult<T> = Promise<{
  data: T | null;
  error: BetterAuthError | null;
}>;

type AuthRuntimeExtensions = {
  getCookie: () => string;
  token: () => ClientResult<{ token: string }>;
  organization: {
    create: (input: { name: string; slug: string }) => ClientResult<{ id: string }>;
    setActive: (input: { organizationId: string }) => ClientResult<unknown>;
  };
};

export const authClient = rawAuthClient as typeof rawAuthClient & AuthRuntimeExtensions;

export function toAuthError(error: BetterAuthError | null | undefined): ApiError {
  return new ApiError(
    error?.status ?? 400,
    error?.code ?? 'auth',
    error?.message ?? error?.statusText ?? 'Authentication failed',
  );
}

export async function authServiceGet<T>(path: string): Promise<T> {
  const nativeCookie = Platform.OS === 'web' ? '' : authClient.getCookie();
  let response: Response;
  try {
    response = await fetch(`${AUTH_URL}${path}`, {
      method: 'GET',
      headers: nativeCookie ? { Cookie: nativeCookie } : undefined,
      credentials: Platform.OS === 'web' ? 'include' : 'omit',
    });
  } catch {
    throw new ApiError(0, 'network', 'Authentication service unavailable');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(
      response.status,
      typeof body?.error === 'string' ? body.error : 'auth',
      typeof body?.message === 'string' ? body.message : 'Authentication failed',
    );
  }
  return response.json() as Promise<T>;
}

export async function mintApiToken(): Promise<string> {
  const { data, error } = await authClient.token();
  if (error || !data?.token) throw toAuthError(error);
  return data.token;
}

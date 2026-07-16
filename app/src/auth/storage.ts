// OWNER: fe-shell — persistence shim. Token lives in the OS keychain on native
// (expo-secure-store) and in AsyncStorage on web (SecureStore has no web impl).
// Non-sensitive session cache + language go through AsyncStorage on every platform.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { Org, Role, User } from '../api/types';

const TOKEN_KEY = 'arvo.auth.token';
const SESSION_KEY = 'arvo.auth.session';
const LANG_KEY = 'arvo.lang';

const useSecureStore = Platform.OS !== 'web';

export type OrgMembership = { id: string; name: string; role: Role };

export interface Session {
  user: User;
  org: Org;
  orgs: OrgMembership[];
  role: Role;
}

export async function getToken(): Promise<string | null> {
  if (useSecureStore) return SecureStore.getItemAsync(TOKEN_KEY);
  return AsyncStorage.getItem(TOKEN_KEY);
}

export async function setToken(token: string): Promise<void> {
  if (useSecureStore) await SecureStore.setItemAsync(TOKEN_KEY, token);
  else await AsyncStorage.setItem(TOKEN_KEY, token);
}

export async function getSession(): Promise<Session | null> {
  const raw = await AsyncStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export async function setSession(session: Session): Promise<void> {
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export async function clearAuth(): Promise<void> {
  await AsyncStorage.removeItem(SESSION_KEY);
  if (useSecureStore) await SecureStore.deleteItemAsync(TOKEN_KEY);
  else await AsyncStorage.removeItem(TOKEN_KEY);
}

export type Lang = 'it' | 'en';

export async function getLang(): Promise<Lang | null> {
  const v = await AsyncStorage.getItem(LANG_KEY);
  return v === 'it' || v === 'en' ? v : null;
}

export async function setLang(lang: Lang): Promise<void> {
  await AsyncStorage.setItem(LANG_KEY, lang);
}

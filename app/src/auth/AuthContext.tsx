// Better Auth session bridge for Arvo's stable auth context contract.
// Better Auth owns credentials/cookies/organizations; the Rust API receives short-lived JWKS
// resource tokens. Non-sensitive profile data remains cached for the offline-first shell.
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

import {
  setAuthToken,
  setAuthTokenProvider,
  setOnUnauthorized,
} from '../api/client';
import type { Org, Role, User } from '../api/types';
import { clearParcelsCache } from '../features/parcels/hooks';
import i18n from '../i18n';
import { resetStore } from '../offline/queue';
import { biometricLockRequired } from './biometric';
import { BiometricLockScreen } from './BiometricGate';
import {
  authClient,
  authServiceGet,
  mintApiToken,
  toAuthError,
} from './client';
import * as storage from './storage';
import type { OrgMembership, Session } from './storage';

type Status = 'restoring' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: Status;
  token: string | null;
  user: User | null;
  org: Org | null;
  orgs: OrgMembership[];
  role: Role | null;
  login: (email: string, password: string) => Promise<void>;
  register: (
    email: string,
    password: string,
    fullName: string,
    orgName: string,
    locale?: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
}

type AuthServiceSession = Session;

const AuthContext = createContext<AuthContextValue | null>(null);

function deviceLocale(): string {
  return i18n.language?.toLowerCase().startsWith('en') ? 'en' : 'it';
}

function organizationSlug(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `${base || 'azienda'}-${Date.now().toString(36)}`;
}

async function canonicalSession(): Promise<AuthServiceSession> {
  return authServiceGet<AuthServiceSession>('/api/arvo/session');
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('restoring');
  const [token, setToken] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [locked, setLocked] = useState(false);
  const pendingRestore = useRef<{ token: string; session: Session | null } | null>(null);
  const tokenRef = useRef<string | null>(null);
  const refreshRef = useRef<Promise<string | null> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function applySession(newToken: string, newSession: Session) {
    setAuthToken(newToken);
    tokenRef.current = newToken;
    if (mountedRef.current) {
      setToken(newToken);
      setSession(newSession);
      setStatus('authenticated');
    }
    try {
      await storage.setToken(newToken);
      await storage.setSession(newSession);
    } catch (error) {
      console.warn('Session persistence failed; continuing in memory.', error);
    }
  }

  async function clearSession() {
    setAuthToken(null);
    tokenRef.current = null;
    if (mountedRef.current) {
      setToken(null);
      setSession(null);
      setStatus('unauthenticated');
    }
    queryClient.clear();
    await storage.clearAuth();
    await resetStore();
    await clearParcelsCache();
  }

  async function establishSession() {
    const [profile, resourceToken] = await Promise.all([canonicalSession(), mintApiToken()]);
    await applySession(resourceToken, profile);
  }

  // Refresh a 15-minute Better Auth resource JWT once, deduplicating concurrent API retries.
  useEffect(() => {
    setAuthTokenProvider(async (forceRefresh) => {
      if (!forceRefresh) return tokenRef.current;
      if (refreshRef.current) return refreshRef.current;
      refreshRef.current = mintApiToken()
        .then(async (next) => {
          setAuthToken(next);
          tokenRef.current = next;
          if (mountedRef.current) setToken(next);
          await storage.setToken(next).catch(() => undefined);
          return next;
        })
        .catch(() => null)
        .finally(() => {
          refreshRef.current = null;
        });
      return refreshRef.current;
    });
    return () => setAuthTokenProvider(null);
  }, []);

  useEffect(() => {
    setOnUnauthorized(() => {
      if (tokenRef.current) void clearSession();
    });
    return () => setOnUnauthorized(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function finishRestore(saved: string, cached: Session | null) {
    setAuthToken(saved);
    tokenRef.current = saved;
    if (mountedRef.current) {
      setToken(saved);
      if (cached) setSession(cached);
      setStatus('authenticated');
    }
    try {
      const { data, error } = await authClient.getSession();
      if (error || !data) {
        await clearSession();
        return;
      }
      await establishSession();
    } catch {
      // Network failure: cached profile + last resource token keep the offline shell available.
    }
  }

  useEffect(() => {
    (async () => {
      let saved: string | null = null;
      let cached: Session | null = null;
      try {
        saved = await storage.getToken();
        if (saved) cached = await storage.getSession();
      } catch {
        saved = null;
      }
      if (!saved) {
        // Better Auth may still have a canonical cookie (for example after a web refresh before
        // our resource token was persisted), so try it once before showing the login screen.
        try {
          const { data } = await authClient.getSession();
          if (data) {
            await establishSession();
            return;
          }
        } catch {
          // Offline with no cached resource token cannot establish an authenticated API shell.
        }
        if (mountedRef.current) setStatus('unauthenticated');
        return;
      }
      if (await biometricLockRequired()) {
        pendingRestore.current = { token: saved, session: cached };
        if (mountedRef.current) setLocked(true);
        return;
      }
      await finishRestore(saved, cached);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleUnlocked() {
    const pending = pendingRestore.current;
    pendingRestore.current = null;
    if (mountedRef.current) setLocked(false);
    if (pending) await finishRestore(pending.token, pending.session);
  }

  async function handleLockLogout() {
    pendingRestore.current = null;
    if (mountedRef.current) setLocked(false);
    await authClient.signOut().catch(() => undefined);
    await clearSession();
  }

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      token,
      user: session?.user ?? null,
      org: session?.org ?? null,
      orgs: session?.orgs ?? [],
      role: session?.role ?? null,
      login: async (email, password) => {
        const { error } = await authClient.signIn.email({ email, password });
        if (error) throw toAuthError(error);
        await establishSession();
      },
      register: async (email, password, fullName, orgName, locale) => {
        const signUpData = {
          email,
          password,
          name: fullName,
          locale: locale ?? deviceLocale(),
        };
        const signUp = await authClient.signUp.email(signUpData);
        if (signUp.error) throw toAuthError(signUp.error);
        const created = await authClient.organization.create({
          name: orgName,
          slug: organizationSlug(orgName),
        });
        if (created.error || !created.data) throw toAuthError(created.error);
        const activated = await authClient.organization.setActive({
          organizationId: created.data.id,
        });
        if (activated.error) throw toAuthError(activated.error);
        await establishSession();
      },
      logout: async () => {
        await authClient.signOut().catch(() => undefined);
        await clearSession();
      },
      switchOrg: async (orgId) => {
        const switched = await authClient.organization.setActive({ organizationId: orgId });
        if (switched.error) throw toAuthError(switched.error);
        await establishSession();
        queryClient.clear();
        await resetStore();
        await clearParcelsCache();
      },
    }),
    // Stateful helpers intentionally read refs/current state rather than changing identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, token, session, queryClient],
  );

  return (
    <AuthContext.Provider value={value}>
      {locked ? (
        <BiometricLockScreen onUnlocked={handleUnlocked} onLogout={handleLockLogout} />
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

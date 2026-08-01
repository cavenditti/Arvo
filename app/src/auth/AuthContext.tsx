// OWNER: auth-flow — auth state (token/user/org/orgs/role), restore-on-boot, and the
// login/register/logout/switchOrg actions. All network access goes through src/api/client.
// Wave-2 peers read `me` data from here: `user` (id/email/full_name/locale), `org`,
// `orgs`, `role`, `status` — typed below, names are stable.
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { api, setAuthToken, setOnUnauthorized } from '../api/client';
import type { AuthResponse, Org, Role, User } from '../api/types';
import { clearParcelsCache } from '../features/parcels/hooks';
import i18n from '../i18n';
import { resetStore } from '../offline/queue';
import { biometricLockRequired } from './biometric';
import { BiometricLockScreen } from './BiometricGate';
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

const AuthContext = createContext<AuthContextValue | null>(null);

function sessionFromLogin(res: AuthResponse): Session {
  const memberships: OrgMembership[] = res.orgs ?? [];
  const active = memberships[0];
  const org: Org = active
    ? { id: active.id, name: active.name }
    : (res.org ?? { id: '', name: '' });
  return {
    user: res.user,
    org,
    orgs: memberships.length ? memberships : [{ id: org.id, name: org.name, role: 'owner' }],
    role: active?.role ?? 'owner',
  };
}

/** The app language ('it'|'en') — what a new account's backend locale should be. */
function deviceLocale(): string {
  return i18n.language?.toLowerCase().startsWith('en') ? 'en' : 'it';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('restoring');
  const [token, setToken] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  // Face ID gate: while true we render the lock screen INSTEAD of the app, and the
  // restored token stays out of context until the unlock succeeds.
  const [locked, setLocked] = useState(false);
  const pendingRestore = useRef<{ token: string; session: Session | null } | null>(null);
  // Mirrors `token` for the 401 handler, which runs outside React's render cycle.
  const tokenRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function applySession(newToken: string, newSession: Session) {
    setAuthToken(newToken);
    tokenRef.current = newToken;
    setToken(newToken);
    setSession(newSession);
    setStatus('authenticated');
    try {
      await storage.setToken(newToken);
      await storage.setSession(newSession);
    } catch (error) {
      // A locally signed iOS preview can lack keychain capabilities even though the
      // authenticated session is otherwise valid. Keep that session in memory rather
      // than turning a persistence failure into a misleading network/login failure.
      // We deliberately do not fall back to AsyncStorage for the token.
      console.warn('Session persistence failed; continuing with an in-memory session.', error);
    }
  }

  async function clearSession() {
    setAuthToken(null);
    tokenRef.current = null;
    setToken(null);
    setSession(null);
    setStatus('unauthenticated');
    queryClient.clear();
    await storage.clearAuth();
    // The next account on this device must never see — or push — this account's offline
    // data: outbox, observations, and the parcels fallback all go.
    await resetStore();
    await clearParcelsCache();
  }

  // A 401 on any request means our token is dead — drop the session (the gate
  // then routes to /login). Ignored while unauthenticated so a bad-credentials
  // 401 during login stays a local form error.
  useEffect(() => {
    setOnUnauthorized(() => {
      if (tokenRef.current) void clearSession();
    });
    return () => setOnUnauthorized(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Second half of restore: expose the saved token/session (optimistic, so the app
  // opens offline), then refresh the profile from /auth/me.
  async function finishRestore(saved: string, cached: Session | null) {
    setAuthToken(saved);
    tokenRef.current = saved;
    if (!mountedRef.current) return;
    setToken(saved);
    if (cached) setSession(cached);
    setStatus('authenticated');
    try {
      const me = await api.get<{ user: User; org: Org; role: Role }>('/auth/me');
      if (!mountedRef.current) return;
      const base: OrgMembership[] = cached?.orgs.length
        ? cached.orgs
        : [{ id: me.org.id, name: me.org.name, role: me.role }];
      const orgs = base.map((o) =>
        o.id === me.org.id ? { id: me.org.id, name: me.org.name, role: me.role } : o,
      );
      const next: Session = { user: me.user, org: me.org, orgs, role: me.role };
      setSession(next);
      await storage.setSession(next);
    } catch {
      // 401 already cleared us via onUnauthorized; other errors = offline, keep cache.
    }
  }

  // Restore on boot: token from secure storage, session from cache. When the optional
  // Face ID lock is on (native only), park the restored pair and show the lock screen
  // instead — nothing is exposed until LocalAuthentication succeeds.
  useEffect(() => {
    (async () => {
      let saved: string | null = null;
      let cached: Session | null = null;
      try {
        saved = await storage.getToken();
        if (saved) cached = await storage.getSession();
      } catch {
        // Secure-storage failures (keystore corruption, first-run races) must land on the
        // login screen, not an eternal splash spinner.
        saved = null;
      }
      if (!saved) {
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
        const res = await api.post<AuthResponse>('/auth/login', { email, password });
        await applySession(res.token, sessionFromLogin(res));
      },
      register: async (email, password, fullName, orgName, locale) => {
        const res = await api.post<AuthResponse>('/auth/register', {
          email,
          password,
          full_name: fullName,
          org_name: orgName,
          // The account speaks the language the person registered in — never a
          // hardcoded 'it' (English devices were getting Italian alerts).
          locale: locale ?? deviceLocale(),
        });
        const org: Org = res.org ?? { id: '', name: orgName };
        await applySession(res.token, {
          user: res.user,
          org,
          orgs: [{ id: org.id, name: org.name, role: 'owner' }],
          role: 'owner',
        });
      },
      logout: clearSession,
      switchOrg: async (orgId) => {
        const membership = session?.orgs.find((o) => o.id === orgId);
        if (!membership || !session) return;
        const res = await api.post<{ token: string }>('/auth/switch-org', { org_id: orgId });
        await applySession(res.token, {
          ...session,
          org: { id: membership.id, name: membership.name },
          role: membership.role,
        });
        queryClient.clear();
        // Offline data is org-scoped: the outbox of org A must not sync into org B.
        await resetStore();
        await clearParcelsCache();
      },
    }),
    // applySession/clearSession are stable closures over setstate + queryClient.
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

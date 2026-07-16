// OWNER: fe-shell — auth state (token/user/org/orgs/role), restore-on-boot, and the
// login/register/logout/switchOrg actions. All network access goes through src/api/client.
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { api, setAuthToken, setOnUnauthorized } from '../api/client';
import type { AuthResponse, Org, Role, User } from '../api/types';
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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('restoring');
  const [token, setToken] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  // Mirrors `token` for the 401 handler, which runs outside React's render cycle.
  const tokenRef = useRef<string | null>(null);

  async function applySession(newToken: string, newSession: Session) {
    setAuthToken(newToken);
    tokenRef.current = newToken;
    setToken(newToken);
    setSession(newSession);
    setStatus('authenticated');
    await storage.setToken(newToken);
    await storage.setSession(newSession);
  }

  async function clearSession() {
    setAuthToken(null);
    tokenRef.current = null;
    setToken(null);
    setSession(null);
    setStatus('unauthenticated');
    queryClient.clear();
    await storage.clearAuth();
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

  // Restore on boot: token from secure storage, session from cache (optimistic,
  // so the app opens offline), then refresh the profile from /auth/me.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const saved = await storage.getToken();
      if (!saved) {
        if (mounted) setStatus('unauthenticated');
        return;
      }
      setAuthToken(saved);
      tokenRef.current = saved;
      const cached = await storage.getSession();
      if (!mounted) return;
      setToken(saved);
      if (cached) setSession(cached);
      setStatus('authenticated');
      try {
        const me = await api.get<{ user: User; org: Org; role: Role }>('/auth/me');
        if (!mounted) return;
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
    })();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      register: async (email, password, fullName, orgName, locale = 'it') => {
        const res = await api.post<AuthResponse>('/auth/register', {
          email,
          password,
          full_name: fullName,
          org_name: orgName,
          locale,
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
      },
    }),
    // applySession/clearSession are stable closures over setstate + queryClient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, token, session, queryClient],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

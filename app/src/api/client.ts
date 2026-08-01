// OWNER: fe-shell — finalize (token storage wiring, 401 → logout). Other agents: import and use
// `api` as-is; do not fetch() directly.
import i18n from '@/i18n';

import type { ApiErrorBody } from './types';

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787';

let authToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}
export function getAuthToken() {
  return authToken;
}
export function setOnUnauthorized(handler: (() => void) | null) {
  onUnauthorized = handler;
}

export class ApiError extends Error {
  constructor(
    /** HTTP status; `0` = no response at all (offline / timeout). Screens branch on this. */
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// Mirrors the backend's 15s outbound-HTTP rule: a hung connection in the field must
// surface as a retryable error, not an endless spinner (and not block the sync mutex).
const REQUEST_TIMEOUT_MS = 15_000;

/** Connectivity-shaped failures: fetch's TypeError, our 15s abort, RN request timeouts. */
function isConnectivityFailure(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const name = e && typeof e === 'object' && 'name' in e ? (e as { name?: unknown }).name : null;
  return name === 'AbortError' || name === 'TimeoutError';
}

function networkError(): ApiError {
  return new ApiError(
    0,
    'network',
    i18n.t('errors.network', {
      defaultValue: 'Nessuna connessione. I dati mostrati potrebbero non essere aggiornati.',
    }),
  );
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/v1${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    // Offline / timed out: one plain-language message instead of a raw TypeError.
    // status 0 + code 'network' keep it machine-readable (offline/queue.ts branches on it).
    throw isConnectivityFailure(e) ? networkError() : e;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 && onUnauthorized) onUnauthorized();
  if (!res.ok) {
    let code = 'internal';
    let message: string | null = null;
    try {
      const data = (await res.json()) as ApiErrorBody;
      code = data.error.code;
      message = data.error.message;
    } catch {
      // non-JSON error body
    }
    if (!message) {
      // No usable server message: plain words instead of "HTTP 503". The exact status
      // stays on ApiError.status for screens that branch on it.
      message =
        res.status >= 500
          ? i18n.t('errors.server', {
              defaultValue: 'Problema temporaneo del server. Riprova tra poco.',
            })
          : i18n.t('errors.request', {
              defaultValue: 'Operazione non riuscita. Riprova.',
            });
    }
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? res.json() : res.text()) as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

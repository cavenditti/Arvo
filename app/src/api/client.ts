// OWNER: fe-shell — finalize (token storage wiring, 401 → logout). Other agents: import and use
// `api` as-is; do not fetch() directly.
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
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && onUnauthorized) onUnauthorized();
  if (!res.ok) {
    let code = 'internal';
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as ApiErrorBody;
      code = data.error.code;
      message = data.error.message;
    } catch {
      // non-JSON error body
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

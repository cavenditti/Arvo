// Short-lived media tokens for URLs that plain <img>/tile clients fetch without headers
// (photos, raster tiles, the season report). The backend rejects session JWTs in query
// strings, so anything URL-shaped goes through here. Refreshed well inside the 15-min TTL.
import { useQuery } from '@tanstack/react-query';

import { API_URL, api } from '@/api/client';

const REFRESH_MS = 10 * 60 * 1000;

export function useMediaToken(): string | null {
  const { data } = useQuery({
    queryKey: ['media-token'],
    queryFn: () => api.post<{ token: string; expires_at: string }>('/auth/media-token'),
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: false,
  });
  return data?.token ?? null;
}

/** Absolute URL for a server media path (e.g. an observation photo), token attached. */
export function mediaUri(path: string, token: string | null): string {
  return token ? `${API_URL}${path}?token=${token}` : `${API_URL}${path}`;
}

// The one alert-action mutation (ack / dismiss / snooze) shared by every surface.
// Optimistic update against the caller's own list key, rollback on error, and a
// prefix invalidation of ['alerts'] so tab badges, banners, and parcel panels all
// refresh no matter which screen acted. Snooze honors the user's 1g/3g/7g choice
// recorded by AlertList (see ./snooze.ts for why it is a side channel).
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';

import { api } from '@/api/client';
import type { Alert } from '@/api/types';

import { readSnoozeDays } from './snooze';

export type AlertAction = 'ack' | 'dismiss' | 'snooze';

const DAY_MS = 86_400_000;

interface ActionInput {
  id: string;
  action: AlertAction;
}

/**
 * @param listKey the query key of the alert list rendered by the calling screen —
 *   it gets the optimistic state flip; everything under ['alerts'] is invalidated after.
 */
export function useAlertActions(listKey: QueryKey) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: ActionInput) => {
      const until =
        action === 'snooze'
          ? new Date(Date.now() + readSnoozeDays() * DAY_MS).toISOString()
          : undefined;
      return api.post<Alert>(`/alerts/${id}/${action}`, action === 'snooze' ? { until } : undefined);
    },
    onMutate: async ({ id, action }: ActionInput) => {
      await qc.cancelQueries({ queryKey: listKey });
      const previous = qc.getQueryData<Alert[]>(listKey);
      if (previous) {
        const state = action === 'ack' ? 'acked' : action === 'dismiss' ? 'dismissed' : 'snoozed';
        qc.setQueryData<Alert[]>(
          listKey,
          previous.map((a) => (a.id === id ? { ...a, state } : a)),
        );
      }
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(listKey, ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  });
}

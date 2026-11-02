'use client';

import { useCallback, useMemo, useState } from 'react';
import type { ObligationAction, ObligationActionResponse, ObligationView } from '@/lib/obligations/contract';
import { withObligationOverrides } from '@/lib/obligations/groups';
import { actionToastTitle, canSendReply } from '@/lib/obligations/labels';
import { postObligationAction } from './data';
import type { NeedsYouNotifier } from './NeedsYouView';
import { sonnerNeedsYouNotifier } from './NeedsYouView';

export type ObligationPost = (
  obligation: ObligationView,
  action: ObligationAction,
) => Promise<ObligationActionResponse>;

const defaultPost: ObligationPost = (obligation, action) => postObligationAction(obligation.id, action);

/**
 * Done, Later, Not mine, Yes/No/Maybe, and Undo on one surface outside the
 * page: the reader strip, the Today list, the calendar dialog. What the user
 * just did shows at once through `overrides`; the live row replaces it when
 * the server catches up. The notifier shows the Undo toast; a surface that
 * shows Undo in place passes a silent one.
 */
export function useObligationActions(
  options: { post?: ObligationPost; notify?: NeedsYouNotifier | null } = {},
) {
  const post = options.post ?? defaultPost;
  const notify = options.notify === undefined ? sonnerNeedsYouNotifier : options.notify;
  const [overrides, setOverrides] = useState<ReadonlyMap<string, ObligationView>>(() => new Map());
  const [undoUntil, setUndoUntil] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);

  const override = useCallback((obligation: ObligationView) => {
    setOverrides((current) => new Map(current).set(obligation.id, obligation));
  }, []);

  const act = useCallback(
    async (obligation: ObligationView, action: ObligationAction): Promise<boolean> => {
      setBusyId(obligation.id);
      setError(null);
      try {
        const response = await post(obligation, action);
        override(response.obligation);
        const until = response.undoUntil;
        setUndoUntil((current) => {
          const next = new Map(current);
          if (until && until > Date.now()) next.set(obligation.id, until);
          else next.delete(obligation.id);
          return next;
        });
        if (notify && action.action !== 'undo') {
          const title = actionToastTitle(action);
          const description =
            action.action === 'done' && canSendReply(obligation) ? 'No reply sent.' : undefined;
          if (until && until > Date.now()) {
            notify.undo({
              title,
              description,
              until,
              onUndo: async () => {
                const undone = await post(obligation, { action: 'undo' });
                override(undone.obligation);
              },
            });
          } else notify.info(title, description);
        }
        return true;
      } catch (caught) {
        setError({
          id: obligation.id,
          text: caught instanceof Error && caught.message ? caught.message : 'Could not save this change.',
        });
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [post, override, notify],
  );

  const undo = useCallback((obligation: ObligationView) => act(obligation, { action: 'undo' }), [act]);
  const merge = useCallback(
    (items: readonly ObligationView[]) => withObligationOverrides(items, overrides),
    [overrides],
  );
  return useMemo(
    () => ({ act, undo, merge, override, overrides, undoUntil, busyId, error }),
    [act, undo, merge, override, overrides, undoUntil, busyId, error],
  );
}

'use client';

// The browser binding for shape actions: the real client store, callTool,
// the Files deep link, and react-query invalidation. The mapping itself is
// lib/chat/shape-actions.ts. Cards call `useShapeActions()` through the
// ShapeCard context and read a status per action key.

import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ShapeAction } from '@/lib/ai/tool-shapes';
import { callTool } from '@/lib/api-client';
import {
  executeShapeAction,
  type ShapeActionDeps,
  type ShapeActionOptions,
  type ShapeActionResult,
} from '@/lib/chat/shape-actions';
import { useClientStore } from '@/lib/client-state';
import { documentDeepLinkUrl, fileToolNavigationPath } from '@/lib/documents/deep-link';

const ALL_ACCOUNTS = '__all__';

function realAccount(value: string | null | undefined): string | undefined {
  return value && value !== ALL_ACCOUNTS ? value : undefined;
}

/** The deps bound to the live app. Store setters read the store at call time. */
export function buildShapeActionDeps(qc: Pick<QueryClient, 'invalidateQueries'>): ShapeActionDeps {
  const state = () => useClientStore.getState();
  const current = state();
  return {
    callTool: (name, args) => callTool(name, args),
    store: {
      setPrimaryView: (view) => state().setPrimaryView(view),
      setSelectedThread: (id) => state().setSelectedThread(id),
      setThreadAccount: (account) => state().setThreadAccount(account),
      setPendingReplyBody: (body) => state().setPendingReplyBody(body),
      setPendingOpenWorkId: (workId) => state().setPendingOpenWorkId(workId),
      setSelectedWorkId: (workId) => state().setSelectedWorkId(workId),
      setSelectedAreaId: (areaId) => state().setSelectedAreaId(areaId),
      setCalendarSearchTarget: (target) => state().setCalendarSearchTarget(target),
      setPendingOpenCardId: (cardId) => state().setPendingOpenCardId(cardId),
      setPendingOpenBoardId: (boardId) => state().setPendingOpenBoardId(boardId),
    },
    openDocument: (documentId, path) => {
      // The same steps the document tool card takes in tool-ui-part.tsx.
      const href = window.location.href;
      const target =
        (path ? fileToolNavigationPath(path, href) : null) ?? documentDeepLinkUrl(documentId, href);
      window.history.pushState(
        { ...(window.history.state || {}), albatrossDocument: documentId },
        '',
        target,
      );
      state().setPrimaryView('files');
      window.dispatchEvent(new Event('lab86-mail:files-navigate'));
    },
    openUrl: (url) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    invalidate: (keys) => {
      for (const key of keys) qc.invalidateQueries({ queryKey: [key] });
    },
    defaultAccount: realAccount(current.threadAccount) ?? realAccount(current.account),
  };
}

export type ActionStatus =
  | { state: 'pending' }
  | { state: 'done'; label: string }
  | { state: 'error'; message: string };

export interface ShapeActionsApi {
  status: Record<string, ActionStatus>;
  run: (key: string, action: ShapeAction, options?: ShapeActionOptions) => Promise<ShapeActionResult>;
}

export function useShapeActions(): ShapeActionsApi {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Record<string, ActionStatus>>({});
  const run = useCallback(
    async (key: string, action: ShapeAction, options?: ShapeActionOptions) => {
      setStatus((prev) => ({ ...prev, [key]: { state: 'pending' } }));
      const result = await executeShapeAction(action, buildShapeActionDeps(qc), options);
      setStatus((prev) => {
        const next = { ...prev };
        if (result.kind === 'navigated') delete next[key];
        else if (result.kind === 'done') next[key] = { state: 'done', label: result.label };
        else next[key] = { state: 'error', message: result.message };
        return next;
      });
      return result;
    },
    [qc],
  );
  return useMemo(() => ({ status, run }), [status, run]);
}

export const ShapeActionsContext = createContext<ShapeActionsApi>({
  status: {},
  run: async () => ({ kind: 'error', message: 'No action context.' }),
});

export function useShapeActionsContext(): ShapeActionsApi {
  return useContext(ShapeActionsContext);
}

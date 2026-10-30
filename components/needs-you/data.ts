'use client';

import { useConvexAuth, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { create } from 'zustand';
import type { NotificationPreferenceInput } from '@/lib/notifications/preferences';
import type {
  NeedsYouSnapshot,
  ObligationAction,
  ObligationActionResponse,
  ObligationDraftResponse,
  ObligationReplyResponse,
} from '@/lib/obligations/contract';

/*
 * The server side of Needs you (docs/needs-you-phase-1.md, S3 to S8) lands in
 * the same PR as this page, so this branch has no generated references for
 * it. The names here are the contract.
 */

export const needsYouQuery = makeFunctionReference<'query', Record<string, never>, NeedsYouSnapshot>(
  'obligations:needsYou',
);

/** `savePreferences` with the optional `obligationPushEnabled` of phase 1 (S8). */
export const savePreferencesWithObligationPush = makeFunctionReference<
  'mutation',
  NotificationPreferenceInput & { obligationPushEnabled?: boolean },
  string
>('albatrossNotifications:savePreferences');

/** The live snapshot. Undefined while it loads, or before sign-in. */
export function useNeedsYouSnapshot(): NeedsYouSnapshot | undefined {
  const { isAuthenticated } = useConvexAuth();
  return useQuery(needsYouQuery, isAuthenticated ? {} : 'skip');
}

type Fetch = typeof fetch;

async function post<T>(url: string, body: unknown, failure: string, fetcher: Fetch): Promise<T> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error((data && typeof data.error === 'string' && data.error) || failure);
  return data as T;
}

const obligationPath = (id: string) => `/api/obligations/${encodeURIComponent(id)}`;

/** Done, Later, Not mine, and Undo. */
export function postObligationAction(
  id: string,
  action: ObligationAction,
  fetcher: Fetch = fetch,
): Promise<ObligationActionResponse> {
  return post(obligationPath(id), action, 'Could not save this change.', fetcher);
}

/** The prepared reply of a mail `reply` obligation. */
export function postObligationDraft(id: string, fetcher: Fetch = fetch): Promise<ObligationDraftResponse> {
  return post(`${obligationPath(id)}/draft`, {}, 'Could not prepare a draft.', fetcher);
}

/** Sends the reply in the thread and closes the obligation. */
export function postObligationReply(
  id: string,
  body: string,
  fetcher: Fetch = fetch,
): Promise<ObligationReplyResponse> {
  return post(`${obligationPath(id)}/reply`, { body }, 'Could not send the reply.', fetcher);
}

/* A one-shot request to open one item on the page. The arrival toast sets
 * it; the page consumes it once. Transient, never persisted. */
interface NeedsYouOpenState {
  request: { id: string; at: number } | null;
  open: (id: string) => void;
  clear: () => void;
}

export const useNeedsYouOpenRequest = create<NeedsYouOpenState>((set) => ({
  request: null,
  open: (id) => set({ request: { id, at: Date.now() } }),
  clear: () => set({ request: null }),
}));

export function requestNeedsYouItem(id: string) {
  useNeedsYouOpenRequest.getState().open(id);
}

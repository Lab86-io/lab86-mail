'use client';

import { useEffect } from 'react';
import { useClientStore } from '@/lib/client-state';
import {
  NEEDS_YOU_PUSH_MESSAGE,
  obligationIdFromSearch,
  type PrimaryView,
  primaryViewFromSearch,
} from '@/lib/shared/types';
import { requestNeedsYouItem } from './data';

/** The page and the item that a push link names. */
export function pushLinkTarget(search: string): { view: PrimaryView | null; obligationId: string | null } {
  return { view: primaryViewFromSearch(search), obligationId: obligationIdFromSearch(search) };
}

/** The search part of the link in a message from the service worker, or null for any other message. */
export function pushMessageSearch(data: unknown): string | null {
  const message = (data ?? {}) as { type?: unknown; url?: unknown };
  if (message.type !== NEEDS_YOU_PUSH_MESSAGE || typeof message.url !== 'string') return null;
  const at = message.url.indexOf('?');
  return at === -1 ? '' : message.url.slice(at);
}

/**
 * A click on a browser notification. A new tab opens with
 * `/?view=notifications&obligation=<id>`. An open tab stays where it is: the
 * service worker sends it the link, so a draft in the tab stays.
 */
export function NeedsYouPushLinks() {
  const setPrimaryView = useClientStore((state) => state.setPrimaryView);
  useEffect(() => {
    const open = (search: string) => {
      const { view, obligationId } = pushLinkTarget(search);
      if (obligationId) requestNeedsYouItem(obligationId);
      if (view) setPrimaryView(view);
    };
    const opened = obligationIdFromSearch(window.location.search);
    if (opened) requestNeedsYouItem(opened);
    const worker = navigator.serviceWorker;
    if (!worker) return;
    const onMessage = (event: MessageEvent) => {
      const search = pushMessageSearch(event.data);
      if (search !== null) open(search);
    };
    worker.addEventListener('message', onMessage);
    return () => worker.removeEventListener('message', onMessage);
  }, [setPrimaryView]);
  return null;
}

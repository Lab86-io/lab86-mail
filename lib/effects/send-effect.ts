'use client';

import { launchSendFireworks } from './send-fireworks';

// Only called after a confirmed delivery, never when a send is still undoable.
export function fireSendEffect() {
  if (typeof window === 'undefined' || !document.body) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  launchSendFireworks();
}

import { useSyncExternalStore } from 'react';
import { documentCspNonce } from '@/lib/security/frame-nonce';

const subscribe = () => () => {};

/**
 * The page CSP nonce for srcdoc frames (see lib/security/frame-nonce.ts). It
 * is empty during server rendering and when the page has no policy.
 */
export function useFrameNonce() {
  return useSyncExternalStore(
    subscribe,
    () => documentCspNonce(),
    () => '',
  );
}

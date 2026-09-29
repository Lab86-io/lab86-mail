import { useSyncExternalStore } from 'react';
import type { BriefFrameCspOptions } from '@/lib/security/brief-frame-csp';
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

/**
 * The origins that a brief frame policy allows for images
 * (lib/security/brief-frame-csp.ts). A sandboxed srcdoc frame has an opaque
 * origin, so its policy names the app origin explicitly. The app origin is
 * empty during server rendering.
 */
export function useBriefFrameCspOptions(): BriefFrameCspOptions {
  const appOrigin = useSyncExternalStore(
    subscribe,
    () => window.location.origin,
    () => '',
  );
  return { appOrigin, storageUrl: process.env.NEXT_PUBLIC_CONVEX_URL };
}

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useBriefFrameCspOptions, useFrameNonce } from '@/hooks/use-frame-nonce';
import { useClientStore } from '@/lib/client-state';
import { sanitizeEmailFrameHtml } from '@/lib/sanitize';
import { type BriefFrameCspOptions, withBriefFrameCsp } from '@/lib/security/brief-frame-csp';
import { withFrameNonce } from '@/lib/security/frame-nonce';
import { readBriefTheme } from '@/lib/theme/brief-theme';

const HEIGHTS = { compact: 180, medium: 300, tall: 460 } as const;

const CANVAS_BRIDGE_JS = `<script>
document.addEventListener('click',function(event){
  var target=event.target&&event.target.closest&&event.target.closest('[data-action]');
  if(!target)return;
  event.preventDefault();
  var payload={};
  try{payload=JSON.parse(target.getAttribute('data-payload')||'{}')||{};}catch(_){}
  parent.postMessage({source:'lab86-brief-canvas',action:target.getAttribute('data-action'),payload:payload},'*');
});
</script>`;

/**
 * The frame document for a canvas leaf, from HTML that the sanitizer already
 * cleaned. Canvas HTML is written against --brief-* tokens with light
 * fallbacks, so the customizer's resolved fonts and colors go in (same
 * contract as postBriefTheme). The canvas is model-written, so the brief frame
 * policy goes first (lib/security/brief-frame-csp.ts).
 */
export function briefCanvasFrameDocument(
  clean: string,
  tokens: Record<string, string>,
  frameCsp?: BriefFrameCspOptions,
): string {
  if (!clean) return '';
  const themeStyle = `<style>:root{${Object.entries(tokens)
    .map(([name, value]) => `${name}:${value}`)
    .join(';')}}</style>`;
  const headClose = clean.toLowerCase().indexOf('</head>');
  const themed =
    headClose >= 0
      ? `${clean.slice(0, headClose)}${themeStyle}${clean.slice(headClose)}`
      : `${themeStyle}${clean}`;
  const bodyClose = themed.toLowerCase().lastIndexOf('</body>');
  const bridged =
    bodyClose >= 0
      ? `${themed.slice(0, bodyClose)}${CANVAS_BRIDGE_JS}${themed.slice(bodyClose)}`
      : `${themed}${CANVAS_BRIDGE_JS}`;
  return withBriefFrameCsp(bridged, frameCsp);
}

export function BriefCanvasLeaf({
  title,
  html,
  fallbackText,
  height,
  allowedActions,
  onAction,
}: {
  title: string;
  html: string;
  fallbackText: string;
  height: keyof typeof HEIGHTS;
  allowedActions: string[];
  onAction: (action: string, payload: Record<string, unknown>) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [srcDoc, setSrcDoc] = useState('');
  const allowed = useMemo(() => new Set(allowedActions), [allowedActions]);
  const appFont = useClientStore((state) => state.appFont);
  // The srcdoc frame inherits the page CSP; its bridge script needs the page nonce.
  const frameNonce = useFrameNonce();
  const { appOrigin, storageUrl } = useBriefFrameCspOptions();

  useEffect(() => {
    const raw = sanitizeEmailFrameHtml(html);
    if (!raw) return;
    setSrcDoc(
      withFrameNonce(
        briefCanvasFrameDocument(raw, readBriefTheme(appFont), { appOrigin, storageUrl }),
        frameNonce,
      ),
    );
  }, [html, appFont, frameNonce, appOrigin, storageUrl]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const data = event.data as { source?: string; action?: unknown; payload?: unknown } | null;
      if (data?.source !== 'lab86-brief-canvas' || typeof data.action !== 'string') return;
      if (!allowed.has(data.action)) return;
      const payload =
        data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload)
          ? (data.payload as Record<string, unknown>)
          : {};
      onAction(data.action, payload);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [allowed, onAction]);

  if (!srcDoc) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-4">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">{fallbackText}</p>
      </div>
    );
  }
  return (
    <iframe
      ref={frameRef}
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]"
      style={{ height: HEIGHTS[height] }}
    />
  );
}

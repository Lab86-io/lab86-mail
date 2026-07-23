'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useClientStore } from '@/lib/client-state';
import { sanitizeEmailFrameHtml } from '@/lib/sanitize';
import { readBriefTheme } from '@/lib/theme/brief-theme';

const HEIGHTS = { compact: 180, medium: 300, tall: 460 } as const;

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

  useEffect(() => {
    const raw = sanitizeEmailFrameHtml(html);
    if (!raw) return;
    // Canvas HTML is written against --brief-* tokens with light fallbacks;
    // mirror the customizer's resolved fonts/colors in so the ornament matches
    // the surrounding native brief (same contract as postBriefTheme).
    const tokens = readBriefTheme(appFont);
    const themeStyle = `<style>:root{${Object.entries(tokens)
      .map(([name, value]) => `${name}:${value}`)
      .join(';')}}</style>`;
    const headClose = raw.toLowerCase().indexOf('</head>');
    const clean =
      headClose >= 0
        ? `${raw.slice(0, headClose)}${themeStyle}${raw.slice(headClose)}`
        : `${themeStyle}${raw}`;
    const bridge = `<script>
document.addEventListener('click',function(event){
  var target=event.target&&event.target.closest&&event.target.closest('[data-action]');
  if(!target)return;
  event.preventDefault();
  var payload={};
  try{payload=JSON.parse(target.getAttribute('data-payload')||'{}')||{};}catch(_){}
  parent.postMessage({source:'lab86-brief-canvas',action:target.getAttribute('data-action'),payload:payload},'*');
});
</script>`;
    const bodyClose = clean.toLowerCase().lastIndexOf('</body>');
    setSrcDoc(
      bodyClose >= 0 ? `${clean.slice(0, bodyClose)}${bridge}${clean.slice(bodyClose)}` : `${clean}${bridge}`,
    );
  }, [html, appFont]);

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

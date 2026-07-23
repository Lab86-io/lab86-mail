'use client';

import { useMemo, useState } from 'react';
import { getDailyArt } from '@/lib/mail/daily-art';

/* The document-v2 masthead: the same daily-art hero the HTML brief carried,
 * rendered natively. Bleeds edge-to-edge against BriefCanvas's padding. Text
 * sits over the artwork, so it stays white-on-scrim in every theme; the title
 * face follows the customizer via font-display. */
export function BriefMasthead({ title, generatedAt }: { title: string; generatedAt: number }) {
  const art = useMemo(() => getDailyArt(generatedAt), [generatedAt]);
  const sources = useMemo(() => [art.imageUrl, ...art.fallbacks], [art]);
  const [sourceIndex, setSourceIndex] = useState(0);
  const src = sourceIndex < sources.length ? sources[sourceIndex] : null;
  const dateline = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(generatedAt));

  return (
    <div className="relative -mx-4 -mt-6 mb-7 @[680px]:-mx-7">
      <div className="relative flex min-h-[220px] items-center justify-center overflow-hidden bg-[var(--color-accent-soft)] px-6 py-14 @[680px]:min-h-[300px]">
        {src ? (
          // Museum-hosted art with ordered fallbacks; plain accent field when
          // every source is down.
          // biome-ignore lint/performance/noImgElement: arbitrary museum-hosted art URLs with client-side onerror fallback walking cannot go through next/image.
          <img
            src={src}
            alt=""
            onError={() => setSourceIndex((index) => index + 1)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : null}
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-b from-black/30 via-black/10 to-black/45"
        />
        <span className="absolute left-4 top-4 z-10 text-[10px] font-medium uppercase tracking-[0.16em] text-white/85 [text-shadow:0_1px_8px_rgba(0,0,0,0.6)]">
          {dateline}
        </span>
        <span className="absolute right-4 top-4 z-10 rounded-full bg-black/35 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-white/90 backdrop-blur-sm">
          The Daily Brief
        </span>
        <h1 className="relative z-10 max-w-4xl text-balance text-center font-display text-[clamp(2.4rem,8cqi,4.75rem)] font-semibold leading-[0.98] tracking-tight text-white [text-shadow:0_2px_28px_rgba(0,0,0,0.5)]">
          {title}
        </h1>
        {art.credit ? (
          <span className="absolute bottom-2.5 right-4 z-10 text-[10px] text-white/75 [text-shadow:0_1px_8px_rgba(0,0,0,0.65)]">
            {art.credit}
            {art.source ? ` · ${art.source}` : ''}
          </span>
        ) : null}
      </div>
    </div>
  );
}

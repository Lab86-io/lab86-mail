'use client';

import { useMemo, useState } from 'react';
import { BRIEF_FRAMES } from '@/lib/brief/frames';
import { artCandidate, getDailyArt } from '@/lib/mail/daily-art';
import { ART_POOL } from '@/lib/mail/daily-art-pool';
import { BriefMasthead } from './BriefMasthead';

/** Development-only composition, shared by Next and the synthetic browser fixture. */
export function FrameGallery() {
  const [now] = useState(() => Date.now());
  const [family, setFamily] = useState('all');
  const [artUrl, setArtUrl] = useState('');
  const fallback = useMemo(() => getDailyArt(now), [now]);
  const frames = BRIEF_FRAMES.filter((frame) => family === 'all' || frame.family === family);
  return (
    <main className="min-h-dvh bg-[var(--color-content)] pb-10 text-[var(--color-text)]">
      <div className="mx-auto max-w-[1100px] px-5 py-8">
        <h1 className="font-display text-[22px] font-semibold">21 picture frames</h1>
        <p className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">
          A frame for each work. {ART_POOL.length} artworks from{' '}
          {new Set(ART_POOL.map((art) => art.source)).size} museums.
        </p>
        <div className="mt-5 flex flex-wrap gap-4 text-[12px]">
          <label className="flex min-w-0 flex-col gap-1">
            Frame collection
            <select
              aria-label="Frame collection"
              value={family}
              onChange={(event) => setFamily(event.target.value)}
              className="rounded-control border border-[var(--color-border)] bg-[var(--color-surface)] p-2"
            >
              <option value="all">All 21 frames</option>
              <option value="museum">Museum · 5</option>
              <option value="gothic">Black Gothic · 6</option>
              <option value="modern">Modern · 5</option>
              <option value="art-deco">Art Deco · 5</option>
            </select>
          </label>
          <label className="flex min-w-0 max-w-full flex-col gap-1">
            Artwork
            <select
              aria-label="Artwork"
              value={artUrl}
              onChange={(event) => setArtUrl(event.target.value)}
              className="max-w-full rounded-control border border-[var(--color-border)] bg-[var(--color-surface)] p-2"
            >
              <option value="">Match artwork to each frame</option>
              {ART_POOL.map((art) => (
                <option key={art.imageUrl} value={art.imageUrl}>
                  {art.title} · {art.artist}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {frames.map((frame, index) => {
        const matches = ART_POOL.filter((piece) => frame.styles.includes(piece.style));
        const piece = ART_POOL.find((piece) => piece.imageUrl === artUrl) ?? matches[index % matches.length];
        const art = piece ? { ...fallback, ...artCandidate(piece) } : fallback;
        return (
          <section key={frame.id} data-frame-gallery-item={frame.id} className="mx-auto max-w-[1100px] px-5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--color-text-muted)]">
              <p>{frame.title}</p>
              <div
                className="flex items-center gap-1"
                role="img"
                aria-label="Colors sampled from the artwork"
              >
                {[...new Set(art.palette)].map((color) => (
                  <span
                    key={color}
                    title={color}
                    className="h-3 w-3 rounded-full border border-black/10"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>
            <div className="@container/brief-canvas brief-canvas">
              <BriefMasthead generatedAt={now} frameId={frame.id} artwork={art} />
            </div>
          </section>
        );
      })}
    </main>
  );
}

'use client';

import type { CSSProperties } from 'react';
import { useMemo, useState } from 'react';
import { TodayWeather } from '@/components/narrative/TodayWorkspace';
import { briefFrameById, briefFrameCreditLine, briefFrameForDay, briefFrameStyle } from '@/lib/brief/frames';
import { artInkColor } from '@/lib/mail/art-palette';
import { type DailyArt, dailyArtCandidates, getDailyArt } from '@/lib/mail/daily-art';
import { dailyBriefDatelineAt, dailyBriefEditionTitleAt } from '@/lib/shared/brief-edition';
import { cn } from '@/lib/utils';
import './brief-layout.css';

/* The daily artwork hangs in a real picture frame. The painting box lines up
 * with the text margin, and the moulding sits outside it, on the wall. The
 * frame follows the artwork's style. Pale ink comes from its actual palette;
 * the title face follows the customizer via
 * font-display. The geometry lives in brief-layout.css. */
export function BriefMasthead({
  generatedAt,
  timezone,
  bleed = true,
  frameId,
  artwork,
  title,
  plain,
}: {
  generatedAt: number;
  timezone?: string;
  /** Replaces "The <weekday> Brief", for the weekly review. */
  title?: string;
  /** False when this masthead must supply its own inset outside BriefCanvas. */
  bleed?: boolean;
  /** Pins one frame, for previews and tests. Unset picks the day's frame. */
  frameId?: string | null;
  /** Supplies a specific artwork in the development gallery. */
  artwork?: DailyArt;
  /** The live Today page: the painting in true color, and the date on its lower edge. */
  plain?: boolean;
}) {
  const art = useMemo(() => artwork ?? getDailyArt(generatedAt), [artwork, generatedAt]);
  // A new day's work remounts the source walker, including after every source fails.
  return (
    <MastheadArtwork
      key={`${generatedAt}:${art.imageUrl}`}
      art={art}
      generatedAt={generatedAt}
      timezone={timezone}
      bleed={bleed}
      frameId={frameId}
      title={title}
      plain={plain}
    />
  );
}

/** "Tuesday, November 3": the day, in the zone of the edition. */
function plainDate(at: number, timezone?: string) {
  return new Intl.DateTimeFormat('en-US', {
    ...(timezone ? { timeZone: timezone } : {}),
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(at));
}

function MastheadArtwork({
  art,
  generatedAt,
  timezone,
  bleed,
  frameId,
  title: titleOverride,
  plain,
}: {
  art: DailyArt;
  generatedAt: number;
  timezone?: string;
  bleed: boolean;
  frameId?: string | null;
  title?: string;
  plain?: boolean;
}) {
  const candidates = useMemo(() => dailyArtCandidates(art), [art]);
  const [sourceIndex, setSourceIndex] = useState(0);
  const displayed = candidates[sourceIndex];
  const src = displayed?.imageUrl;
  const frame = useMemo(
    () => briefFrameById(frameId) ?? briefFrameForDay(generatedAt, timezone, displayed?.style ?? 'modern'),
    [frameId, generatedAt, timezone, displayed?.style],
  );
  const ink = useMemo(() => artInkColor(displayed?.palette), [displayed?.palette]);
  const dateline = dailyBriefDatelineAt(generatedAt, timezone);
  const title = titleOverride?.trim() || dailyBriefEditionTitleAt(generatedAt, timezone);

  return (
    <div
      className={cn('brief-masthead', bleed ? 'brief-masthead--canvas' : 'brief-masthead--page')}
      style={
        {
          ...briefFrameStyle(frame),
          '--brief-art-ink': ink,
          '--brief-ink-grain': 'url("/frames/ink-grain.svg")',
        } as CSSProperties
      }
      data-brief-frame={frame.id}
      data-art-style={displayed?.style ?? 'modern'}
    >
      <figure data-brief-art-frame className="brief-masthead__figure">
        {/* The plate is the painting box alone. The moulding hangs off it, so
            the wall label below never ends up inside the frame. */}
        <div className="brief-masthead__plate">
          <div
            className={cn(
              'brief-masthead__painting relative overflow-hidden bg-[var(--color-accent-soft)] p-4',
              plain
                ? 'flex h-[192px] items-end justify-between gap-4 @[680px]:h-[min(360px,34vh)] @[680px]:min-h-[260px] @[680px]:p-6'
                : 'grid h-[250px] grid-rows-[1fr_auto_1fr] @[680px]:h-[300px]',
            )}
          >
            {src ? (
              // Museum-hosted art with ordered fallbacks; plain accent field when
              // every source is down.
              // biome-ignore lint/performance/noImgElement: arbitrary museum-hosted art URLs with client-side onerror fallback walking cannot go through next/image.
              <img
                key={src}
                src={src}
                alt=""
                onError={() => setSourceIndex((index) => (index === sourceIndex ? index + 1 : index))}
                className={cn(
                  'absolute inset-0 h-full w-full object-cover',
                  // A scan often ends in a bright edge. The frame opening hides it.
                  plain && 'scale-[1.03]',
                )}
              />
            ) : null}
            {plain ? (
              <>
                {/* The scrim sits only under the words, so the painting keeps its color. */}
                <div aria-hidden className="brief-masthead__foot absolute inset-x-0 bottom-0 h-[46%]" />
                <h1 className="relative z-10 min-w-0 text-balance font-display text-[clamp(1.75rem,5cqi,3rem)] font-medium leading-[1.04] tracking-tight text-white [text-shadow:0_1px_18px_rgba(0,0,0,0.45)]">
                  {plainDate(generatedAt, timezone)}
                </h1>
                <div className="relative z-10 min-w-0 shrink pb-1 text-right">
                  <TodayWeather variant="plate" />
                </div>
              </>
            ) : (
              <>
                <div aria-hidden className="brief-masthead__scrim absolute inset-0" />
                <span className="absolute left-4 right-4 top-4 z-10 text-[10px] font-medium text-white/85 [text-shadow:0_1px_8px_rgba(0,0,0,0.6)]">
                  {dateline}
                </span>
                {/* Texture is clipped to the lettering; one semantic heading remains. */}
                <div className="relative z-10 row-start-2 flex min-w-0 items-center justify-center">
                  <h1 className="brief-masthead__title max-w-4xl text-balance text-center font-display text-[clamp(2.4rem,8cqi,4.75rem)] font-bold leading-[0.98] tracking-tight">
                    <span className="brief-masthead__ink">{title}</span>
                  </h1>
                </div>
                <div className="relative z-10 row-start-3 flex min-w-0 justify-center self-start pt-3">
                  <TodayWeather variant="masthead" />
                </div>
              </>
            )}
            <div aria-hidden className="brief-masthead__rabbet" />
          </div>
          <div aria-hidden className="brief-masthead__moulding" />
        </div>
        {/* The wall label: the painting, then the frame, set to the right edge. */}
        <figcaption className="brief-masthead__label">
          <span>
            {displayed?.credit}
            {displayed?.source ? ` · ${displayed.source}` : ''}
          </span>
          {/* The live page keeps the credit that a source is owed, and drops the one that is ours. */}
          <span
            className={plain && frame.credit.startsWith('Albatross') ? 'hidden @[680px]:inline' : undefined}
          >
            {plain && frame.credit.startsWith('Albatross')
              ? `Frame: ${frame.title}`
              : briefFrameCreditLine(frame)}
          </span>
        </figcaption>
      </figure>
    </div>
  );
}

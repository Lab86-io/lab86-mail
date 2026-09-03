'use client';

import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { useEntered } from '@/components/albatross/LaterCard';
import type { HoldCard } from '@/lib/albatross/capture-client';
import { horizonLine } from '@/lib/albatross/horizon';
import { cn } from '@/lib/utils';

// The Hold landing. The bar text collapses to one serif line. When the
// capture answers, the shape word and the horizon line fade in under the
// parsed title. Then the card moves toward the Work rail and the bar clears.
// Three beats of 200 ms. A split shows one card per Work, 60 ms apart.

export const HOLD_COLLAPSE_MS = 200;
export const HOLD_CARD_MS = 200;
export const HOLD_LEAVE_MS = 200;
export const HOLD_STAGGER_MS = 60;
export const HOLD_RAIL_TARGET_SELECTOR = '[data-rail-target="albatrosses"]';

export type HoldPhase = 'holding' | 'card' | 'leave';

/** How long the leave beat lasts for `count` cards. */
export function holdLeaveDuration(count: number): number {
  return HOLD_LEAVE_MS + HOLD_STAGGER_MS * Math.max(0, count - 1);
}

/** The serif line the text collapses to: its first line, trimmed. */
export function holdTitleFromText(text: string): string {
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first || text.trim();
}

export interface HoldOffset {
  x: number;
  y: number;
}

/** The translation that moves a card center onto the rail target center. Null without a target. */
export function holdOffsetToward(card: DOMRect | null, target: DOMRect | null): HoldOffset | null {
  if (!card || !target || target.width === 0 || target.height === 0) return null;
  const x = target.left + target.width / 2 - (card.left + card.width / 2);
  const y = target.top + target.height / 2 - (card.top + card.height / 2);
  return { x, y };
}

function defaultRailTarget(): Element | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector(HOLD_RAIL_TARGET_SELECTOR);
}

function rectOf(element: Element | null | undefined): DOMRect | null {
  if (!element || typeof (element as HTMLElement).getBoundingClientRect !== 'function') return null;
  return element.getBoundingClientRect();
}

/** A 200 ms tint on the rail row, so the card visibly arrives. */
function pulseRailTarget(target: Element | null) {
  const element = target as HTMLElement | null;
  if (!element || typeof element.animate !== 'function') return;
  const tint =
    typeof getComputedStyle === 'function'
      ? getComputedStyle(element).getPropertyValue('--color-accent-2-soft').trim()
      : '';
  if (!tint) return;
  element.animate([{ backgroundColor: tint }, { backgroundColor: 'transparent' }], {
    duration: HOLD_LEAVE_MS * 2,
    easing: 'cubic-bezier(0.4, 0, 1, 1)',
  });
}

export interface HoldLandingProps {
  /** The text the user held. Shown as the serif line until the cards arrive. */
  text: string;
  /** Null while the capture runs. */
  cards: HoldCard[] | null;
  nowMs: number;
  reduceMotion?: boolean;
  /** The rail row the card moves toward. Defaults to the sidebar Albatrosses item. */
  railTarget?: () => Element | null;
  onDone: () => void;
}

export function HoldLanding({
  text,
  cards,
  nowMs,
  reduceMotion = false,
  railTarget = defaultRailTarget,
  onDone,
}: HoldLandingProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [phase, setPhase] = useState<HoldPhase>('holding');
  const [offsets, setOffsets] = useState<Array<HoldOffset | null>>([]);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const railTargetRef = useRef(railTarget);
  railTargetRef.current = railTarget;

  // Beat one: the serif line holds for at least 200 ms.
  useEffect(() => {
    const timer = setTimeout(() => setCollapsed(true), HOLD_COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, []);

  // Beat two and three run once, when the cards are here and beat one is over.
  const count = cards?.length ?? 0;
  const startedRef = useRef(false);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;
  useEffect(() => {
    if (!cards || !collapsed || startedRef.current) return;
    startedRef.current = true;
    setPhase('card');
    const leaveAt = HOLD_CARD_MS;
    const doneAt = leaveAt + holdLeaveDuration(count);
    timersRef.current.push(
      setTimeout(() => {
        const target = railTargetRef.current();
        pulseRailTarget(target);
        // With reduced movement the card stays in place until the bar clears.
        if (reduceMotionRef.current) return;
        const targetRect = rectOf(target);
        setOffsets(
          cardRefs.current.slice(0, count).map((card) => holdOffsetToward(rectOf(card), targetRect)),
        );
        setPhase('leave');
      }, leaveAt),
    );
    timersRef.current.push(setTimeout(() => onDoneRef.current(), doneAt));
  }, [cards, collapsed, count]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) clearTimeout(timer);
      timersRef.current = [];
    },
    [],
  );

  const rows: HoldCard[] =
    phase === 'holding' || !cards
      ? [{ id: 'holding', title: holdTitleFromText(text), shape: 'quick', horizon: null }]
      : cards;

  return (
    <div data-hold-landing data-phase={phase} aria-live="polite" className="flex flex-col gap-1.5 px-1 py-1">
      {rows.map((card, index) => (
        <HoldLandingCard
          key={index === 0 ? 'first' : card.id}
          ref={(element) => {
            cardRefs.current[index] = element;
          }}
          card={card}
          index={index}
          phase={phase}
          parsed={phase !== 'holding'}
          nowMs={nowMs}
          reduceMotion={reduceMotion}
          offset={offsets[index] ?? null}
        />
      ))}
    </div>
  );
}

function HoldLandingCard({
  ref,
  card,
  index,
  phase,
  parsed,
  nowMs,
  reduceMotion,
  offset,
}: {
  ref: (element: HTMLDivElement | null) => void;
  card: HoldCard;
  index: number;
  phase: HoldPhase;
  parsed: boolean;
  nowMs: number;
  reduceMotion: boolean;
  offset: HoldOffset | null;
}) {
  const entered = useEntered();
  const line = parsed ? horizonLine(card.horizon, nowMs) : null;
  const leaving = phase === 'leave';
  const delayMs = index * HOLD_STAGGER_MS;
  const style: CSSProperties = {
    transitionDelay: `${delayMs}ms`,
    ...(leaving && offset && !reduceMotion
      ? { transform: `translate(${Math.round(offset.x)}px, ${Math.round(offset.y)}px) scale(0.92)` }
      : {}),
  };
  return (
    <div
      ref={ref}
      data-hold-card={card.id}
      data-leaving={leaving || undefined}
      style={style}
      className={cn(
        'flex min-w-0 flex-col gap-0.5 rounded-lg px-1.5 py-1',
        'transition-[transform,opacity] motion-reduce:transition-none',
        leaving
          ? 'duration-[var(--duration-normal)] ease-[var(--ease-exit)] opacity-0'
          : 'duration-[var(--duration-normal)] ease-[var(--ease-enter)]',
        !leaving && (index === 0 || entered) ? 'translate-y-0 opacity-100' : null,
        !leaving && index > 0 && !entered ? 'translate-y-1 opacity-0' : null,
        leaving && (!offset || reduceMotion) ? 'scale-[0.92]' : null,
        'motion-reduce:translate-y-0 motion-reduce:scale-100',
      )}
    >
      <p className="truncate font-serif text-[15px] font-semibold leading-snug text-[var(--color-text)]">
        {card.title}
      </p>
      <p
        data-hold-meta
        className={cn(
          'flex min-h-[16px] items-baseline gap-1.5 text-[12px] leading-none',
          'transition-opacity duration-[var(--duration-normal)] ease-[var(--ease-enter)] motion-reduce:transition-none',
          parsed ? 'opacity-100' : 'opacity-0',
        )}
      >
        {parsed ? <span className="text-[var(--color-text-muted)]">{card.shape}</span> : null}
        {line ? <span className="text-[var(--color-accent-3)]">{line}</span> : null}
      </p>
    </div>
  );
}

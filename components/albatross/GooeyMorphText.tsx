'use client';

/* Gooey Text Morphing — ported from @victorwelander's 21st.dev component
 * (https://21st.dev). Two absolutely-stacked spans blur and cross-fade under
 * an SVG feColorMatrix alpha-threshold filter so overlapping glyphs merge
 * into one gooey mass mid-morph. The rAF loop and blur/opacity math follow
 * the original algorithm; the state transitions live in pure helpers below
 * so they stay testable without a DOM. */

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ */
/* Pure morph model (exported for bun:test - keep DOM-free)            */
/* ------------------------------------------------------------------ */

export interface GooeyMorphState {
  /** Index of the word currently dissolving out (text1). */
  wordIndex: number;
  /** Seconds accumulated into the current morph. */
  morph: number;
  /** Seconds left holding the settled word before the next morph. */
  cooldown: number;
  /** Seconds a full morph takes. */
  morphTime: number;
  /** Seconds to hold between morphs. */
  cooldownTime: number;
  /** Number of words in the rotation. */
  wordCount: number;
}

export function initialMorphState(input: {
  morphTime: number;
  cooldownTime: number;
  wordCount: number;
}): GooeyMorphState {
  // Start on the last word so the settled text2 (index + 1) shows texts[0],
  // matching the original component's textIndex = texts.length - 1 seed.
  return {
    wordIndex: Math.max(input.wordCount - 1, 0),
    morph: 0,
    cooldown: input.cooldownTime,
    ...input,
  };
}

/** One rAF step of the original algorithm. While cooling down the morph
 *  progress stays reset; when the cooldown runs out the word index advances
 *  once and the overflow time seeds the morph so pacing is frame-rate safe. */
export function nextMorphState(state: GooeyMorphState, dt: number): GooeyMorphState {
  const shouldAdvance = state.cooldown > 0;
  const cooldown = state.cooldown - dt;
  if (cooldown > 0) {
    // doCooldown: hold the settled pair, keep morph progress at zero.
    return { ...state, morph: 0, cooldown };
  }
  // doMorph: -cooldown is the slice of this frame already spent morphing.
  const wordCount = Math.max(state.wordCount, 1);
  const wordIndex = shouldAdvance ? (state.wordIndex + 1) % wordCount : state.wordIndex;
  const morph = state.morph - cooldown;
  // Morph complete: park on a fresh cooldown; the fraction clamps to 1.
  const settled = morph / state.morphTime >= 1;
  return { ...state, wordIndex, morph, cooldown: settled ? state.cooldownTime : 0 };
}

export type GooeyMorphFrame = { phase: 'cooldown' } | { phase: 'morph'; fraction: number };

/** How to paint a state: cooldown snaps text2 visible / text1 hidden,
 *  otherwise blend by the clamped morph fraction. */
export function morphFrameOf(state: GooeyMorphState): GooeyMorphFrame {
  if (state.cooldown > 0) return { phase: 'cooldown' };
  return { phase: 'morph', fraction: Math.min(state.morph / state.morphTime, 1) };
}

/** blur(min(8/fraction - 8, 100)px) - the original's gooey falloff. */
export function morphBlurPx(fraction: number): number {
  if (fraction <= 0) return 100;
  return Math.min(8 / fraction - 8, 100);
}

/** opacity = fraction^0.4 - eases visibility in ahead of sharpness. */
export function morphOpacity(fraction: number): number {
  if (fraction <= 0) return 0;
  return Math.min(fraction, 1) ** 0.4;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export interface GooeyMorphTextProps {
  texts: readonly string[];
  className?: string;
  morphTime?: number;
  cooldownTime?: number;
}

export function GooeyMorphText({
  texts,
  className,
  morphTime = 1.1,
  cooldownTime = 1.6,
}: GooeyMorphTextProps) {
  const text1Ref = useRef<HTMLSpanElement>(null);
  const text2Ref = useRef<HTMLSpanElement>(null);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduceMotion(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduceMotion(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (reduceMotion || texts.length < 2) return;
    const text1 = text1Ref.current;
    const text2 = text2Ref.current;
    if (!text1 || !text2) return;

    let state = initialMorphState({ morphTime, cooldownTime, wordCount: texts.length });
    let last = performance.now();
    let raf = 0;

    const paint = () => {
      text1.textContent = texts[state.wordIndex % texts.length];
      text2.textContent = texts[(state.wordIndex + 1) % texts.length];
      const frame = morphFrameOf(state);
      if (frame.phase === 'cooldown') {
        text2.style.filter = '';
        text2.style.opacity = '1';
        text1.style.filter = '';
        text1.style.opacity = '0';
        return;
      }
      const inverse = 1 - frame.fraction;
      text2.style.filter = `blur(${morphBlurPx(frame.fraction)}px)`;
      text2.style.opacity = `${morphOpacity(frame.fraction)}`;
      text1.style.filter = `blur(${morphBlurPx(inverse)}px)`;
      text1.style.opacity = `${morphOpacity(inverse)}`;
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = (now - last) / 1000;
      last = now;
      state = nextMorphState(state, dt);
      paint();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduceMotion, texts, morphTime, cooldownTime]);

  if (reduceMotion || texts.length < 2) {
    return <span className={className}>{texts[0] ?? ''}</span>;
  }

  // Invisible sizer holds layout at the widest word so containers stay stable.
  const longest = texts.reduce((a, b) => (b.length > a.length ? b : a), texts[0]);

  return (
    <span className={cn('relative inline-block', className)}>
      <svg aria-hidden="true" role="presentation" className="absolute" width="0" height="0" focusable="false">
        <defs>
          <filter id="gooey-text-threshold">
            <feColorMatrix
              in="SourceGraphic"
              type="matrix"
              values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 255 -140"
            />
          </filter>
        </defs>
      </svg>
      <span aria-hidden className="invisible block whitespace-nowrap">
        {longest}
      </span>
      <span aria-hidden className="absolute inset-0" style={{ filter: 'url(#gooey-text-threshold)' }}>
        <span
          ref={text1Ref}
          className="absolute inset-0 flex items-center justify-center whitespace-nowrap opacity-0"
        >
          {texts[texts.length - 1]}
        </span>
        <span ref={text2Ref} className="absolute inset-0 flex items-center justify-center whitespace-nowrap">
          {texts[0]}
        </span>
      </span>
      <span className="sr-only">{texts[0]}</span>
    </span>
  );
}

export default GooeyMorphText;

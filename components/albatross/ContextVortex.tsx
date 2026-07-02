'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/* Shared "black hole" loading treatment for long AI work (plan generation,
 * daily brief). Fills its parent (absolute inset-0; parent must be
 * position:relative). Labeled context cards fly from the edges into a slowly
 * growing center singularity. Completion is the parent's job — unmount inside
 * AnimatePresence and let the arriving content spring out. */

export interface VortexSource {
  id: string;
  label: string;
  kind: 'mail' | 'calendar' | 'tasks' | 'areas' | 'web' | 'notes';
}

export const DEFAULT_VORTEX_SOURCES: VortexSource[] = [
  { id: 'mail', label: 'Mail', kind: 'mail' },
  { id: 'calendar', label: 'Calendar', kind: 'calendar' },
  { id: 'tasks', label: 'Tasks', kind: 'tasks' },
  { id: 'areas', label: 'Areas', kind: 'areas' },
  { id: 'web', label: 'Web', kind: 'web' },
];

/* ---------------------------------------------------------------- timings */

export const SPAWN_SPACING_MS = 700;
export const SPAWN_JITTER_MS = 320;
export const CARD_MIN_DURATION_MS = 2_200;
export const CARD_MAX_DURATION_MS = 3_200;
export const ORB_GROWTH_MS = 25_000;
export const ORB_GROWTH_SCALE = 0.6; // 1 -> 1.6
export const ORB_PULSE_MS = 3_000;
export const ORB_PULSE_AMPLITUDE = 0.04;

const EDGES = ['top', 'right', 'bottom', 'left'] as const;
export type VortexEdge = (typeof EDGES)[number];

export interface CardPlan {
  /** Which container edge the card spawns from. */
  edge: VortexEdge;
  /** Spawn position, percent of container (can sit just outside 0..100). */
  startX: number;
  startY: number;
  /** Curved-path midpoint, percent of container. */
  midX: number;
  midY: number;
  /** Delay before launch, ms from mount (includes index stagger). */
  delay: number;
  /** Flight time, ms. */
  duration: number;
  /** Final rotation at the moment the card is swallowed, degrees. */
  rotate: number;
  /** Which source label to show: cycles through the sources list. */
  sourceIndex: number;
}

/** Deterministic PRNG (mulberry32) so trajectories are testable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EDGE_OFFSCREEN = 8; // percent past the container edge

/** Pure spawn planner: everything about card #index derives from (index, seed). */
export function spawnPlan(
  index: number,
  seed: number,
  sourceCount = DEFAULT_VORTEX_SOURCES.length,
): CardPlan {
  const rnd = mulberry32((Math.floor(seed) * 1_000_003 + index * 7_919) >>> 0);
  const edge = EDGES[Math.floor(rnd() * EDGES.length)] ?? 'top';
  const along = 6 + rnd() * 88; // stay off the exact corners
  let startX: number;
  let startY: number;
  if (edge === 'top') [startX, startY] = [along, -EDGE_OFFSCREEN];
  else if (edge === 'bottom') [startX, startY] = [along, 100 + EDGE_OFFSCREEN];
  else if (edge === 'left') [startX, startY] = [-EDGE_OFFSCREEN, along];
  else [startX, startY] = [100 + EDGE_OFFSCREEN, along];

  // Arc the flight: midpoint = halfway to center + a perpendicular bulge.
  const dx = 50 - startX;
  const dy = 50 - startY;
  const len = Math.hypot(dx, dy) || 1;
  const bulge = (7 + rnd() * 9) * (rnd() < 0.5 ? -1 : 1);
  const midX = startX + dx * 0.5 + (-dy / len) * bulge;
  const midY = startY + dy * 0.5 + (dx / len) * bulge;

  return {
    edge,
    startX,
    startY,
    midX,
    midY,
    delay: index * SPAWN_SPACING_MS + rnd() * SPAWN_JITTER_MS,
    duration: CARD_MIN_DURATION_MS + rnd() * (CARD_MAX_DURATION_MS - CARD_MIN_DURATION_MS),
    rotate: (rnd() * 2 - 1) * 14,
    sourceIndex: sourceCount > 0 ? index % sourceCount : 0,
  };
}

/** Singularity scale: slow growth to 1.6 over ~25s plus a gentle ~3s breath. */
export function orbScaleAt(elapsedMs: number): number {
  const t = Math.max(0, elapsedMs);
  const growth = 1 + ORB_GROWTH_SCALE * Math.min(1, t / ORB_GROWTH_MS);
  const pulse = ORB_PULSE_AMPLITUDE * Math.sin((t / ORB_PULSE_MS) * Math.PI * 2);
  return growth + pulse;
}

/* ------------------------------------------------------------- rendering */

const LANE_COUNT = 7;
// Lanes are stable identities (each lane recycles its own card forever).
const LANES = Array.from({ length: LANE_COUNT }, (_, i) => i);

function FlyingCard({
  lane,
  seed,
  sources,
  width,
  height,
}: {
  lane: number;
  seed: number;
  sources: VortexSource[];
  width: number;
  height: number;
}) {
  const [cycle, setCycle] = useState(0);
  const index = lane + cycle * LANE_COUNT;
  const plan = useMemo(() => spawnPlan(index, seed, sources.length), [index, seed, sources.length]);
  const source = sources[plan.sourceIndex % sources.length];
  if (!source) return null;

  const toPx = (xPct: number, yPct: number) => ({
    x: ((xPct - 50) / 100) * width,
    y: ((yPct - 50) / 100) * height,
  });
  const start = toPx(plan.startX, plan.startY);
  const mid = toPx(plan.midX, plan.midY);
  // First flight keeps the full index stagger; respawns only keep the jitter.
  const delayMs = cycle === 0 ? plan.delay : plan.delay - index * SPAWN_SPACING_MS + 260;

  return (
    <motion.div
      key={cycle}
      className="absolute left-1/2 top-1/2 z-[3]"
      initial={{ x: start.x, y: start.y, scale: 1, rotate: 0, opacity: 0 }}
      animate={{
        x: [start.x, mid.x, 0],
        y: [start.y, mid.y, 0],
        scale: [1, 0.78, 0.2],
        rotate: [0, plan.rotate * 0.5, plan.rotate],
        opacity: [0, 1, 1, 0],
      }}
      transition={{
        duration: plan.duration / 1000,
        delay: delayMs / 1000,
        ease: [0.5, 0.05, 0.85, 0.4],
        opacity: { duration: plan.duration / 1000, delay: delayMs / 1000, times: [0, 0.18, 0.78, 1] },
      }}
      onAnimationComplete={() => setCycle((c) => c + 1)}
    >
      <div className="flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-md border border-white/15 bg-[var(--color-bg-elevated)] py-1 pl-2 pr-2.5 shadow-[0_2px_10px_rgba(0,0,0,0.45)]">
        <span className="size-1 shrink-0 rounded-full bg-[var(--color-accent)]" />
        <span className="text-[11px] font-medium leading-none text-[var(--color-text-muted)]">
          {source.label}
        </span>
      </div>
    </motion.div>
  );
}

export function ContextVortex({
  title,
  subtitle,
  sources = DEFAULT_VORTEX_SOURCES,
  className,
}: {
  title?: string;
  subtitle?: string;
  sources?: VortexSource[];
  className?: string;
}) {
  const reducedMotion = useReducedMotion();
  const frameRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [seed] = useState(() => Math.floor(Math.random() * 2 ** 31));

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const orb = (
    <div
      className={cn('size-[88px] rounded-full', reducedMotion && 'animate-pulse [animation-duration:3s]')}
      style={{
        background:
          'radial-gradient(circle at 40% 34%, color-mix(in oklab, var(--color-accent) 92%, white) 0%, var(--color-accent) 16%, color-mix(in oklab, var(--color-accent) 34%, black) 42%, #05060a 68%, #000 82%)',
        boxShadow:
          '0 0 44px 10px color-mix(in oklab, var(--color-accent) 38%, transparent), 0 0 120px 34px color-mix(in oklab, var(--color-accent) 14%, transparent), inset 0 0 22px 6px rgba(0,0,0,0.85)',
      }}
    />
  );

  return (
    <div
      ref={frameRef}
      className={cn('absolute inset-0 select-none overflow-hidden', className)}
      role="status"
      aria-live="polite"
    >
      {/* Backdrop: pure CSS — a dark accent-tinted radial. No shader layers
          (they read gray, cost three.js, and die on context loss). */}
      <div
        className="absolute inset-0 z-0"
        style={{
          background:
            'radial-gradient(120% 100% at 50% 42%, color-mix(in oklab, var(--color-accent) 13%, #05060a) 0%, #05060a 52%, #020308 100%)',
        }}
      />

      {!reducedMotion && size
        ? LANES.map((lane) => (
            <FlyingCard
              key={`lane-${lane}`}
              lane={lane}
              seed={seed}
              sources={sources}
              width={size.w}
              height={size.h}
            />
          ))
        : null}

      {/* The singularity: slow growth wrapper -> breathing pulse -> orb + ring. */}
      <div className="absolute left-1/2 top-1/2 z-[4] -translate-x-1/2 -translate-y-1/2">
        {reducedMotion ? (
          orb
        ) : (
          <motion.div
            initial={{ scale: 1 }}
            animate={{ scale: 1 + ORB_GROWTH_SCALE }}
            transition={{ duration: ORB_GROWTH_MS / 1000, ease: 'linear' }}
          >
            <motion.div
              className="relative"
              animate={{ scale: [1, 1 + ORB_PULSE_AMPLITUDE, 1] }}
              transition={{ duration: ORB_PULSE_MS / 1000, repeat: Infinity, ease: 'easeInOut' }}
            >
              <motion.div
                aria-hidden
                className="absolute -inset-4 rounded-full opacity-70"
                style={{
                  background:
                    'conic-gradient(from 0deg, transparent 0deg, color-mix(in oklab, var(--color-accent) 55%, transparent) 42deg, transparent 128deg, color-mix(in oklab, var(--color-accent) 28%, transparent) 214deg, transparent 300deg)',
                  WebkitMaskImage:
                    'radial-gradient(closest-side, transparent 60%, black 66%, black 80%, transparent 86%)',
                  maskImage:
                    'radial-gradient(closest-side, transparent 60%, black 66%, black 80%, transparent 86%)',
                }}
                animate={{ rotate: 360 }}
                transition={{ duration: 14, repeat: Infinity, ease: 'linear' }}
              />
              {orb}
            </motion.div>
          </motion.div>
        )}
      </div>

      {title || subtitle ? (
        <div className="absolute inset-x-0 top-[calc(50%+96px)] z-[5] px-8 text-center">
          {title ? (
            <p className="mx-auto max-w-[520px] truncate font-serif text-[17px] italic leading-snug text-white/90">
              {title}
            </p>
          ) : null}
          {subtitle ? (
            <p className="mx-auto mt-1.5 max-w-[440px] truncate text-[12px] text-white/55">{subtitle}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

'use client';

// Vertical adaptation of MagicUI's Dock component.
// Source: https://magicui.design/r/dock.json (registry/magicui/dock.tsx) —
// the mouse-position MotionValue → per-tile distance transform → useSpring
// pipeline (mass 0.1 / stiffness 150 / damping 12) is theirs, kept intact.
//
// Changes for this app:
// - Horizontal → vertical: the rail tracks mouseY (clientY, matching
//   getBoundingClientRect coordinates — the registry mixes pageX with rect.x,
//   which drifts under scroll) and measures distance to each tile's vertical
//   center. Tiles grow in both width and height.
// - The registry injects props via React.cloneElement, which only reaches
//   direct children; here a context carries the shared mouseY so tiles can
//   sit at any depth (the sidebar keeps its group structure).
// - Tiles are focusable <button>s. Hover OR keyboard focus shows a floating
//   macOS-style name label to the RIGHT of the tile; focus also applies the
//   magnified size (accessibility parity with hover). The label renders in a
//   body portal with position:fixed, so it floats over the main content —
//   no layout shift, and no clipping by overflow/scroll ancestors.
// - useReducedMotion: no magnification (tiles stay at baseSize); the label
//   still appears instantly on hover/focus.

import {
  type MotionValue,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useSpring,
  useTransform,
} from 'motion/react';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { dockPointerDistance, dockTileSize } from '@/lib/dock-magnify';
import { cn } from '@/lib/utils';

// The registry's spring, verbatim.
const DOCK_SPRING = { mass: 0.1, stiffness: 150, damping: 12 };

const DOCK_DEFAULT_SIZE = 32;
const DOCK_DEFAULT_MAGNIFICATION = 44;
const DOCK_DEFAULT_RANGE = 96;

interface DockContextValue {
  mouseY: MotionValue<number>;
  baseSize: number;
  magnifiedSize: number;
  range: number;
  reduced: boolean;
}

const DockContext = React.createContext<DockContextValue | null>(null);

/** Non-null when rendered inside a DockRail — tiles use it to magnify. */
export function useDock(): DockContextValue | null {
  return React.useContext(DockContext);
}

export interface DockRailProps extends React.ComponentProps<'div'> {
  /** Resting tile size in px. */
  baseSize?: number;
  /** Tile size in px under the cursor. */
  magnifiedSize?: number;
  /** Distance in px over which magnification decays back to baseSize. */
  range?: number;
}

/**
 * The dock container: tracks the pointer's Y position across the whole rail
 * (Infinity when the pointer leaves) and shares it with descendant DockTiles
 * via context. Renders a plain div — bring your own layout classes.
 */
export function DockRail({
  baseSize = DOCK_DEFAULT_SIZE,
  magnifiedSize = DOCK_DEFAULT_MAGNIFICATION,
  range = DOCK_DEFAULT_RANGE,
  onMouseMove,
  onMouseLeave,
  children,
  ...props
}: DockRailProps) {
  const mouseY = useMotionValue(Infinity);
  const reduced = useReducedMotion() ?? false;
  const value = React.useMemo(
    () => ({ mouseY, baseSize, magnifiedSize, range, reduced }),
    [mouseY, baseSize, magnifiedSize, range, reduced],
  );

  return (
    <div
      data-slot="dock-rail"
      {...props}
      onMouseMove={(event) => {
        mouseY.set(event.clientY);
        onMouseMove?.(event);
      }}
      onMouseLeave={(event) => {
        mouseY.set(Infinity);
        onMouseLeave?.(event);
      }}
    >
      <DockContext.Provider value={value}>{children}</DockContext.Provider>
    </div>
  );
}

export interface DockTileProps extends React.ComponentProps<'button'> {
  /**
   * Floating name label shown beside the tile while it is hovered or
   * keyboard-focused. Also becomes the button's accessible name when no
   * aria-label is provided.
   */
  label?: string;
}

/**
 * One dock tile: a focusable button whose width/height follow the registry's
 * distance transform, spring-smoothed. Children render centered and keep
 * their own size (the tile grows around them, as in the registry).
 */
export function DockTile({
  label,
  className,
  style,
  children,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  ...props
}: DockTileProps) {
  const dock = React.useContext(DockContext);
  const ref = React.useRef<HTMLButtonElement>(null);
  // A tile outside any DockRail still renders — at rest, never magnified.
  const restingY = useMotionValue(Infinity);
  const mouseY = dock?.mouseY ?? restingY;
  const baseSize = dock?.baseSize ?? DOCK_DEFAULT_SIZE;
  const magnifiedSize = dock?.magnifiedSize ?? DOCK_DEFAULT_MAGNIFICATION;
  const range = dock?.range ?? DOCK_DEFAULT_RANGE;
  const reduced = dock?.reduced ?? false;

  const distance = useTransform(mouseY, (pointer: number) => {
    const bounds = ref.current?.getBoundingClientRect();
    if (!bounds) return Infinity;
    return dockPointerDistance(pointer, bounds.top, bounds.height);
  });
  const targetSize = useTransform(distance, (value: number) =>
    dockTileSize({ distance: value, baseSize, magnifiedSize, range }),
  );
  const springSize = useSpring(targetSize, DOCK_SPRING);

  const [hovered, setHovered] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const labelVisible = Boolean(label) && (hovered || focused);

  // The floating label tracks the tile while neighbors resize under the
  // cursor. Its position lives in MotionValues updated from the size spring,
  // so per-frame tracking never re-renders React.
  const labelLeft = useMotionValue(0);
  const labelTop = useMotionValue(0);
  const syncLabel = React.useCallback(() => {
    const bounds = ref.current?.getBoundingClientRect();
    if (!bounds) return;
    labelLeft.set(bounds.right + 10);
    labelTop.set(bounds.top + bounds.height / 2);
  }, [labelLeft, labelTop]);
  useMotionValueEvent(springSize, 'change', () => {
    if (labelVisible) syncLabel();
  });
  React.useEffect(() => {
    if (labelVisible) syncLabel();
  }, [labelVisible, syncLabel]);

  // Reduced motion: fixed size. Keyboard focus: pinned to the magnified size
  // (parity with a hovered tile). Otherwise the spring drives it.
  const sizeStyle: number | MotionValue<number> = reduced ? baseSize : focused ? magnifiedSize : springSize;

  return (
    <>
      <motion.button
        type="button"
        aria-label={label}
        {...(props as React.ComponentProps<typeof motion.button>)}
        ref={ref}
        data-slot="dock-tile"
        style={{ ...style, width: sizeStyle, height: sizeStyle }}
        className={cn('relative flex shrink-0 items-center justify-center', className)}
        onMouseEnter={(event) => {
          setHovered(true);
          onMouseEnter?.(event);
        }}
        onMouseLeave={(event) => {
          setHovered(false);
          onMouseLeave?.(event);
        }}
        onFocus={(event) => {
          // Only keyboard-driven focus magnifies — a mouse click also focuses,
          // and a tile stuck large after click-and-leave reads as a glitch.
          let keyboard = true;
          try {
            keyboard = event.currentTarget.matches(':focus-visible');
          } catch {
            keyboard = true;
          }
          setFocused(keyboard);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
      >
        {children}
      </motion.button>
      {labelVisible && typeof document !== 'undefined'
        ? createPortal(
            <motion.span
              aria-hidden
              initial={reduced ? false : { opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              transition={reduced ? { duration: 0 } : { duration: 0.12, ease: 'easeOut' }}
              style={{ left: labelLeft, top: labelTop, y: '-50%' }}
              className="pointer-events-none fixed z-[70] whitespace-nowrap rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1 text-[12px] font-medium text-[var(--color-text)] shadow-[var(--shadow-pop)]"
            >
              {label}
            </motion.span>,
            document.body,
          )
        : null}
    </>
  );
}

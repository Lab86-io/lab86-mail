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
//   no layout shift, and no clipping by overflow/scroll ancestors. Labels
//   align to one axis: a fixed gap past the RAIL's right edge (not the
//   tile's), so they clear the rail cleanly and don't crowd the content.
// - Hover/focus also mounts the shared strengthened treatment from
//   lib/dock-hover.ts: an accent radial glow behind the tile (springing with
//   the magnification) and an accent ring on its surface. The intents rail's
//   Chamaac dock (components/ui/chamaac-dock.tsx) reuses DockTileGlow and
//   DockTileLabel so both docks speak one hover language.
// - useReducedMotion: no magnification (tiles stay at baseSize); the label
//   and glow still appear, instantly, on hover/focus.

import {
  type MotionStyle,
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
import {
  type DockGlowCurve,
  dockGlowMotion,
  dockHoverGlow,
  dockHoverRing,
  dockLabelLeft,
} from '@/lib/dock-hover';
import { dockGlyphScale, dockPointerDistance, dockTileSize } from '@/lib/dock-magnify';
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
      // After the spread on purpose: callers pass their own data-slot (the
      // sidebar passes "sidebar-inner" for its wash CSS), which would clobber
      // data-slot="dock-rail" — this dedicated marker is what DockTile's
      // label axis measurement anchors to.
      data-dock-rail=""
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
    // All labels share one left axis: a fixed gap past the rail's right
    // edge, so the label clears the rail (and any magnified neighbor)
    // instead of hugging the tile and crowding the content beside it.
    const rail = ref.current?.closest('[data-dock-rail]')?.getBoundingClientRect();
    labelLeft.set(dockLabelLeft(bounds.right, rail?.right));
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
  // The glyph inside the tile grows with the same spring (a fixed-size icon
  // floating in a swelling button reads as broken). Exposed as a CSS var so
  // callers opt their glyph in with `scale-(--dock-glyph-scale)` — the tile
  // can't scale `children` wholesale because absolutely-positioned layers
  // (the selected shine border) must keep hugging the button bounds.
  const glyphScaleValue = useTransform(springSize, (value: number) => dockGlyphScale(value, baseSize));
  const glyphScale: number | MotionValue<number> = reduced
    ? 1
    : focused
      ? dockGlyphScale(magnifiedSize, baseSize)
      : glyphScaleValue;
  // motion resolves MotionValues assigned to CSS custom properties at
  // runtime, but MotionStyle's types don't model --vars — hence the cast.
  const glyphScaleStyle = { '--dock-glyph-scale': glyphScale } as unknown as MotionStyle;
  const highlighted = hovered || focused;

  return (
    <>
      <motion.button
        type="button"
        aria-label={label}
        {...(props as React.ComponentProps<typeof motion.button>)}
        ref={ref}
        data-slot="dock-tile"
        data-highlighted={highlighted || undefined}
        style={{
          ...style,
          width: sizeStyle,
          height: sizeStyle,
          ...glyphScaleStyle,
          // Surface highlight (lib/dock-hover.ts): accent ring + lift shadow
          // on the hovered/focused tile only. Inline so it wins over any
          // caller shadow classes without a specificity fight.
          ...(highlighted ? { boxShadow: dockHoverRing() } : null),
        }}
        // `isolate` keeps the -z glow layer inside this button's stacking
        // context — without it the glow would paint underneath the rail's
        // opaque background and vanish.
        className={cn('relative isolate flex shrink-0 items-center justify-center', className)}
        onMouseEnter={(event) => {
          // Synchronous first measure: the portal label mounts with the right
          // position on its first frame (the spring listener keeps it synced
          // from there as neighbors resize).
          syncLabel();
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
          if (keyboard) syncLabel();
          setFocused(keyboard);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
      >
        <DockTileGlow visible={highlighted} reduced={reduced} />
        {children}
      </motion.button>
      <DockTileLabel visible={labelVisible} left={labelLeft} top={labelTop} reduced={reduced}>
        {label}
      </DockTileLabel>
    </>
  );
}

/**
 * The strengthened hover glow shared by both docks: a soft accent radial
 * behind the tile (see lib/dock-hover.ts for the design references). Mounted
 * on every tile but fully transparent unless `visible` — only the hovered or
 * focused tile ever shows it, and it animates out instead of popping.
 * `curve`: 'spring' rides the magnification spring (this dock); 'fade' is the
 * Chamaac dock's 0.2s tween.
 */
export function DockTileGlow({
  visible,
  reduced,
  curve = 'spring',
  className,
}: {
  visible: boolean;
  reduced: boolean;
  curve?: DockGlowCurve;
  className?: string;
}) {
  return (
    <motion.span
      aria-hidden
      data-slot="dock-tile-glow"
      initial={false}
      {...dockGlowMotion(visible, reduced, curve)}
      style={{ background: dockHoverGlow() }}
      className={cn('pointer-events-none absolute -inset-2 -z-10 rounded-full', className)}
    />
  );
}

/**
 * The floating name label shared by both docks: a fixed-position body portal
 * beside the rail (no layout shift, no clipping by scroll ancestors).
 * `left`/`top` may be MotionValues (this dock tracks the magnification
 * spring) or plain numbers (the Chamaac dock's tiles don't resize).
 * `shape="pill"` matches the Chamaac dock's fully-rounded, blurred shell.
 */
export function DockTileLabel({
  visible,
  left,
  top,
  reduced,
  shape = 'tag',
  children,
}: {
  visible: boolean;
  left: MotionValue<number> | number;
  top: MotionValue<number> | number;
  reduced: boolean;
  shape?: 'tag' | 'pill';
  children: React.ReactNode;
}) {
  if (!visible || typeof document === 'undefined') return null;
  return createPortal(
    <motion.span
      aria-hidden
      initial={reduced ? false : { opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={reduced ? { duration: 0 } : { duration: 0.12, ease: 'easeOut' }}
      style={{ left, top, y: '-50%' }}
      className={cn(
        'pointer-events-none fixed z-[70] whitespace-nowrap border border-[var(--color-border)] px-2 py-1 text-[12px] font-medium text-[var(--color-text)] shadow-[var(--shadow-pop)]',
        shape === 'pill'
          ? 'rounded-full bg-[color-mix(in_oklab,var(--color-bg-elevated)_86%,transparent)] px-2.5 backdrop-blur-md'
          : 'rounded-md bg-[var(--color-bg-elevated)]',
      )}
    >
      {children}
    </motion.span>,
    document.body,
  );
}

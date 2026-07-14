'use client';

// Chamaac Dock, localized. Source: https://www.chamaac.com/r/dock.json
// (registry/chamaac/dock/dock.tsx — "A navigation dock component with smooth
// animations and hover effects"), fetched 2026-07-06 and adapted for the
// Albatross intents rail.
//
// What's kept — the component's signature look and behavior:
// - The floating pill shell: rounded-[25px], 3px inner padding, hairline
//   border, backdrop-blur-md over a translucent surface. Their bg is
//   bg-white / dark:bg-black/50; here it's the same translucency built from
//   theme vars so accent-hued themes and light/dark both work.
// - 3px gaps between tiles, fully-rounded (rounded-full) tiles.
// - The hover/active treatment: a soft neutral FILL that fades in over 0.2s
//   and is held on for the active item (their DockIcon/DockItem states). The
//   source animates backgroundColor with a motion 0.2s tween between fixed
//   hexes (#F0F0F0 / #262626); motion can't tween var()/color-mix() strings,
//   so the identical curve here is a 200ms CSS color transition to theme
//   vars. Hover additionally gets the shared strengthened treatment from
//   lib/dock-hover.ts (accent radial glow + accent ring) using Chamaac's
//   0.2s fade curve — the same treatment the main rail's dock uses.
//
// What's adapted:
// - Orientation: vertical column (the source is a horizontal bottom nav).
// - Marketing-nav parts are dropped: Next Link/Image items, the dropdown
//   sections that grow the pill, and the fullscreen mobile menu. Tiles are
//   plain focusable <button>s (the rail's expansion stays the existing
//   explicit overlay in PlansSurface — never hover-driven).
// - NO magnification, faithfully: the Chamaac dock does not magnify, which
//   is exactly why this file does not use lib/dock-magnify.ts (that curve
//   belongs to the MagicUI-derived dock in components/ui/dock.tsx). Its
//   animation "curve" is the 0.2s fill fade above.
// - The source has no tooltip for icon tiles, so the floating name label is
//   ours (shared DockTileLabel), in its pill shape to match this shell.

import { useMotionValue, useReducedMotion } from 'motion/react';
import * as React from 'react';
import { DockTileGlow, DockTileLabel } from '@/components/ui/dock';
import { dockHoverRing, dockLabelLeft } from '@/lib/dock-hover';
import { cn } from '@/lib/utils';

/**
 * The pill shell. Layout is the caller's (it renders a plain flex column);
 * the shell only contributes Chamaac's shape, backdrop, and item spacing.
 */
export function ChamaacDock({ className, children, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="chamaac-dock"
      className={cn(
        // The source shell, verbatim shape: p-[3px] rounded-[25px] border
        // backdrop-blur-md, translucent surface.
        'relative flex flex-col items-center gap-[3px] rounded-[25px] border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-bg-elevated)_78%,transparent)] p-[3px] shadow-[var(--shadow-soft)] backdrop-blur-md',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface ChamaacDockTileProps extends React.ComponentProps<'button'> {
  /**
   * Floating name label shown beside the dock while hovered or keyboard-
   * focused; also the accessible name when no aria-label is given.
   */
  label?: string;
  /** Held-on fill, the source's active-page state. */
  active?: boolean;
  /** Tile edge in px (the source uses a 42px row; 40 keeps this rail's grid). */
  size?: number;
}

/**
 * One tile: fixed size (no magnification — see header), rounded-full, with
 * Chamaac's 0.2s fill fade on hover, a held fill when active, and the shared
 * strengthened hover treatment (glow + accent ring) on hover/focus.
 */
export function ChamaacDockTile({
  label,
  active = false,
  size = 40,
  className,
  style,
  children,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  ...props
}: ChamaacDockTileProps) {
  const ref = React.useRef<HTMLButtonElement>(null);
  const reduced = useReducedMotion() ?? false;
  const [hovered, setHovered] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const highlighted = hovered || focused;
  const labelVisible = Boolean(label) && highlighted;

  // The label clears the dock shell (not just the tile) so every tile's name
  // lands on the same axis. Tiles never resize, so one measurement per
  // reveal is enough — taken synchronously in the enter/focus handlers, so
  // the portal mounts with the right position on its very first frame (an
  // effect would land one frame late and flash the label at 0,0).
  const labelLeft = useMotionValue(0);
  const labelTop = useMotionValue(0);
  const syncLabel = React.useCallback(() => {
    const bounds = ref.current?.getBoundingClientRect();
    if (!bounds) return;
    const shell = ref.current?.closest('[data-slot="chamaac-dock"]')?.getBoundingClientRect();
    labelLeft.set(dockLabelLeft(bounds.right, shell?.right));
    labelTop.set(bounds.top + bounds.height / 2);
  }, [labelLeft, labelTop]);

  return (
    <>
      <button
        type="button"
        aria-label={label}
        data-slot="chamaac-dock-tile"
        data-active={active || undefined}
        data-highlighted={highlighted || undefined}
        {...props}
        ref={ref}
        style={{
          width: size,
          height: size,
          // Shared surface highlight (lib/dock-hover.ts): accent ring + lift.
          ...(highlighted ? { boxShadow: dockHoverRing() } : null),
          ...style,
        }}
        className={cn(
          // Chamaac's 0.2s color fade, as a CSS transition (see header).
          'relative isolate flex shrink-0 items-center justify-center rounded-full outline-none transition-[background-color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
          active
            ? 'bg-[var(--color-accent-soft)]'
            : highlighted
              ? 'bg-[var(--color-bg-elevated)]'
              : 'bg-transparent',
          className,
        )}
        onMouseEnter={(event) => {
          syncLabel();
          setHovered(true);
          onMouseEnter?.(event);
        }}
        onMouseLeave={(event) => {
          setHovered(false);
          onMouseLeave?.(event);
        }}
        onFocus={(event) => {
          // Keyboard focus only — a mouse click also focuses, and a tile
          // stuck highlighted after click-and-leave reads as a glitch.
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
        <DockTileGlow visible={highlighted} reduced={reduced} curve="fade" />
        {children}
      </button>
      <DockTileLabel visible={labelVisible} left={labelLeft} top={labelTop} reduced={reduced} shape="pill">
        {label}
      </DockTileLabel>
    </>
  );
}

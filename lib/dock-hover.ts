// The strengthened dock-tile hover treatment, shared by BOTH docks (the main
// rail's MagicUI-derived dock in components/ui/dock.tsx and the intents
// rail's Chamaac dock in components/ui/chamaac-dock.tsx): the hovered or
// keyboard-focused tile — and only that tile — gets a soft accent radial
// glow behind it plus a clearer surface highlight (each dock supplies its
// elevated background; the accent ring + lift shadow come from here).
//
// Designed references:
// - MagicUI magic-card, orb mode (https://magicui.design/r/magic-card.json):
//   a blurred radial-gradient glow that trails the pointer. Here the glow is
//   pinned to the tile center (the tile IS the pointer target) and the fixed
//   hex stops become a color-mix of the theme accent so it tracks the user's
//   accent hue in both light and dark.
// - Chamaac dock (https://www.chamaac.com/r/dock.json): hover is a fill that
//   fades in over 0.2s rather than snapping — dockGlowMotion's 'fade' curve
//   is that tween; the 'spring' curve reuses the magnification spring so the
//   glow breathes in and out with the tile on the main rail.
//
// Hard rules honored: one glow at a time (only the hovered tile's layer is
// visible), nothing permanent, no pulsing/rainbow — a single accent hue —
// and reduced motion swaps the animation for an instant state change.
//
// Pure string/config builders, no React and no DOM: bun:test covers this
// directly (tests/dock-hover.test.ts).

/** The magnification spring from components/ui/dock.tsx, reused verbatim so
 * the glow moves on the same curve as the tile it backs. */
export const DOCK_GLOW_SPRING = { mass: 0.1, stiffness: 150, damping: 12 } as const;

/** Chamaac's hover curve: a plain 0.2s fade (their `duration: 0.2` tween). */
export const DOCK_GLOW_FADE = { duration: 0.2 } as const;

/**
 * CSS background for the glow layer behind the hovered tile: a radial accent
 * wash that reaches full transparency at the layer's edge (`closest-side`,
 * so it never paints a hard rectangle). Theme-var driven — pass a different
 * accent expression to retint.
 */
export function dockHoverGlow(accent = 'var(--color-accent)'): string {
  return `radial-gradient(closest-side, color-mix(in oklab, ${accent} 30%, transparent), transparent)`;
}

/**
 * CSS box-shadow for the hovered tile's surface highlight: a 1px accent ring
 * (soft — 32% of the accent, so it reads as an edge, not a border) over the
 * theme's lift shadow.
 */
export function dockHoverRing(accent = 'var(--color-accent)'): string {
  return `0 0 0 1px color-mix(in oklab, ${accent} 32%, transparent), var(--shadow-soft)`;
}

export type DockGlowCurve = 'spring' | 'fade';

/**
 * Motion props for the glow layer. `spring` rides the magnification spring
 * (main rail); `fade` is Chamaac's 0.2s tween (intents rail). Reduced motion:
 * the glow still appears/disappears, instantly and without the scale swell.
 */
export function dockGlowMotion(visible: boolean, reduced: boolean, curve: DockGlowCurve = 'spring') {
  if (reduced) {
    return {
      animate: { opacity: visible ? 1 : 0, scale: 1 },
      transition: { duration: 0 },
    };
  }
  return {
    animate: { opacity: visible ? 1 : 0, scale: visible ? 1 : 0.75 },
    transition: curve === 'fade' ? DOCK_GLOW_FADE : DOCK_GLOW_SPRING,
  };
}

/**
 * Left edge in px for a tile's floating name label: a fixed gap past the
 * RAIL's right edge (not the tile's), so every label lands on the same axis
 * and always clears the rail even while neighbors magnify. Falls back to the
 * tile's own right edge when the rail couldn't be measured.
 */
export function dockLabelLeft(tileRight: number, railRight: number | null | undefined, gap = 12): number {
  const edge =
    typeof railRight === 'number' && Number.isFinite(railRight) ? Math.max(tileRight, railRight) : tileRight;
  return edge + gap;
}

// Pure interpolation math for the dock magnification effect (macOS dock
// physics): tiles grow as the cursor nears their center, neighbors grow
// proportionally less, and everything relaxes back at the edge of the range.
//
// Ported from MagicUI's Dock (https://magicui.design/r/dock.json,
// registry/magicui/dock.tsx). The registry computes each icon's size with a
// clamped linear motion transform:
//
//   useTransform(distance, [-range, 0, range], [base, magnified, base])
//
// dockTileSize is that exact curve as a plain function (framer's default
// transform clamps outside the input range, so beyond `range` the size pins
// to `baseSize`). dockPointerDistance mirrors the registry's distanceCalc
// (pointer minus tile center), reoriented for a vertical rail. No React, no
// DOM — bun:test covers this directly; components/ui/dock.tsx consumes it.
//
// Scope note: this math belongs to the MagicUI-derived dock only. The
// intents rail's Chamaac dock (components/ui/chamaac-dock.tsx) faithfully
// does NOT magnify — the source component has no size curve at all, just a
// 0.2s background fade — so it intentionally has no consumer here. The
// hover treatment the two docks DO share lives in lib/dock-hover.ts.

export interface DockTileSizeInput {
  /**
   * Signed px distance from the pointer to the tile's center. Infinity (the
   * rail's "pointer left" sentinel) or NaN resolve to the resting size.
   */
  distance: number;
  /** Resting tile size in px. */
  baseSize: number;
  /** Tile size in px when the pointer sits dead-center on the tile. */
  magnifiedSize: number;
  /** Distance in px at which magnification has fully decayed to baseSize. */
  range: number;
}

/** The registry's clamped linear size curve: peak at 0, baseSize at ±range. */
export function dockTileSize({ distance, baseSize, magnifiedSize, range }: DockTileSizeInput): number {
  if (!Number.isFinite(distance) || range <= 0) return baseSize;
  const offset = Math.abs(distance);
  if (offset >= range) return baseSize;
  return baseSize + (magnifiedSize - baseSize) * (1 - offset / range);
}

/**
 * Signed distance from a pointer coordinate to the center of a tile that
 * starts at `edge` and spans `extent` px (the registry's distanceCalc,
 * vertical: pointer = clientY, edge = rect.top, extent = rect.height).
 * A non-finite pointer (the "left the rail" sentinel) stays Infinity so the
 * size curve rests.
 */
export function dockPointerDistance(pointer: number, edge: number, extent: number): number {
  if (!Number.isFinite(pointer)) return Infinity;
  return pointer - edge - extent / 2;
}

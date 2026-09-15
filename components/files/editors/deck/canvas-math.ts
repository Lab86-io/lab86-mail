/**
 * Pure geometry for the slide canvas: pointer pixels to slide percent,
 * move and resize with eight box handles or two line ends, and snap guides
 * to the slide edges, the slide center and the edges of other elements.
 * No React, no DOM. Every result is rounded to two decimals of a percent.
 */

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface LineBounds extends Bounds {
  flip?: boolean;
}
export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export type BoxHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export type LineHandle = 'start' | 'end';
export interface Guide {
  axis: 'x' | 'y';
  at: number;
}
export interface SnapTargets {
  xs: number[];
  ys: number[];
}
export interface Snapped<T extends Bounds> {
  bounds: T;
  guides: Guide[];
}

/** Percent of the slide within which an edge snaps to a guide. */
export const SNAP_THRESHOLD = 1;
/** Pixels the pointer must travel before a press becomes a drag. */
export const DRAG_START_PX = 3;
export const BOX_HANDLES: BoxHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export const LINE_HANDLES: LineHandle[] = ['start', 'end'];

const round = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A pointer movement in pixels as a movement in slide percent. */
export function percentDelta(rect: Pick<Rect, 'width' | 'height'>, dxPx: number, dyPx: number): Point {
  if (!(rect.width > 0) || !(rect.height > 0)) return { x: 0, y: 0 };
  return { x: (dxPx / rect.width) * 100, y: (dyPx / rect.height) * 100 };
}

/** A pointer position as a slide percent, clamped to the slide. */
export function pointerToPercent(rect: Rect, clientX: number, clientY: number): Point {
  if (!(rect.width > 0) || !(rect.height > 0)) return { x: 0, y: 0 };
  return {
    x: round(clamp(((clientX - rect.left) / rect.width) * 100, 0, 100)),
    y: round(clamp(((clientY - rect.top) / rect.height) * 100, 0, 100)),
  };
}

/** A pointer position over an image preview as a focal point, 0 to 1. */
export function focalFromPointer(rect: Rect, clientX: number, clientY: number): Point {
  const percent = pointerToPercent(rect, clientX, clientY);
  return { x: round(percent.x / 100), y: round(percent.y / 100) };
}

/** Guide positions: the slide edges and center plus every edge and center of the other elements. */
export function snapTargets(others: Bounds[]): SnapTargets {
  const xs = new Set([0, 50, 100]);
  const ys = new Set([0, 50, 100]);
  for (const other of others) {
    xs.add(round(other.x));
    xs.add(round(other.x + other.width / 2));
    xs.add(round(other.x + other.width));
    ys.add(round(other.y));
    ys.add(round(other.y + other.height / 2));
    ys.add(round(other.y + other.height));
  }
  return { xs: [...xs].sort((a, b) => a - b), ys: [...ys].sort((a, b) => a - b) };
}

function nearest(values: number[], targets: number[], threshold: number) {
  let best: { value: number; target: number; distance: number } | null = null;
  for (const value of values) {
    for (const target of targets) {
      const distance = Math.abs(value - target);
      if (distance <= threshold && (!best || distance < best.distance)) best = { value, target, distance };
    }
  }
  return best;
}

/** Keep a box inside the slide without changing its size. */
export function moveBounds<T extends Bounds>(origin: T, delta: Point): T {
  const width = clamp(origin.width, 0, 100);
  const height = clamp(origin.height, 0, 100);
  return {
    ...origin,
    x: round(clamp(origin.x + delta.x, 0, 100 - width)),
    y: round(clamp(origin.y + delta.y, 0, 100 - height)),
    width: round(width),
    height: round(height),
  };
}

/** Shift a moved box so its nearest edge or center sits on a guide. */
export function snapBounds<T extends Bounds>(
  bounds: T,
  targets: SnapTargets,
  threshold = SNAP_THRESHOLD,
): Snapped<T> {
  const guides: Guide[] = [];
  let x = bounds.x;
  let y = bounds.y;
  const snapX = nearest(
    [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width],
    targets.xs,
    threshold,
  );
  if (snapX) {
    x = clamp(bounds.x + (snapX.target - snapX.value), 0, 100 - bounds.width);
    guides.push({ axis: 'x', at: snapX.target });
  }
  const snapY = nearest(
    [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height],
    targets.ys,
    threshold,
  );
  if (snapY) {
    y = clamp(bounds.y + (snapY.target - snapY.value), 0, 100 - bounds.height);
    guides.push({ axis: 'y', at: snapY.target });
  }
  return { bounds: { ...bounds, x: round(x), y: round(y) }, guides };
}

/** Resize from one of eight handles. The opposite edge stays put; the box stays on the slide. */
export function resizeBounds<T extends Bounds>(origin: T, handle: BoxHandle, delta: Point, minSize = 1): T {
  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.width;
  let bottom = origin.y + origin.height;
  if (handle.includes('w')) left = clamp(origin.x + delta.x, 0, right - minSize);
  if (handle.includes('e')) right = clamp(right + delta.x, left + minSize, 100);
  if (handle.includes('n')) top = clamp(origin.y + delta.y, 0, bottom - minSize);
  if (handle.includes('s')) bottom = clamp(bottom + delta.y, top + minSize, 100);
  return {
    ...origin,
    x: round(left),
    y: round(top),
    width: round(right - left),
    height: round(bottom - top),
  };
}

/** Snap only the edges a resize handle moves. */
export function snapResize<T extends Bounds>(
  bounds: T,
  handle: BoxHandle,
  targets: SnapTargets,
  threshold = SNAP_THRESHOLD,
  minSize = 1,
): Snapped<T> {
  const guides: Guide[] = [];
  let left = bounds.x;
  let top = bounds.y;
  let right = bounds.x + bounds.width;
  let bottom = bounds.y + bounds.height;
  if (handle.includes('w')) {
    const snap = nearest([left], targets.xs, threshold);
    if (snap && snap.target <= right - minSize) {
      left = snap.target;
      guides.push({ axis: 'x', at: snap.target });
    }
  }
  if (handle.includes('e')) {
    const snap = nearest([right], targets.xs, threshold);
    if (snap && snap.target >= left + minSize) {
      right = snap.target;
      guides.push({ axis: 'x', at: snap.target });
    }
  }
  if (handle.includes('n')) {
    const snap = nearest([top], targets.ys, threshold);
    if (snap && snap.target <= bottom - minSize) {
      top = snap.target;
      guides.push({ axis: 'y', at: snap.target });
    }
  }
  if (handle.includes('s')) {
    const snap = nearest([bottom], targets.ys, threshold);
    if (snap && snap.target >= top + minSize) {
      bottom = snap.target;
      guides.push({ axis: 'y', at: snap.target });
    }
  }
  return {
    bounds: {
      ...bounds,
      x: round(left),
      y: round(top),
      width: round(right - left),
      height: round(bottom - top),
    },
    guides,
  };
}

/** The two ends of a line. `flip` runs the line from bottom-left to top-right. */
export function lineEndpoints(line: LineBounds): { start: Point; end: Point } {
  if (line.flip) {
    return {
      start: { x: line.x, y: line.y + line.height },
      end: { x: line.x + line.width, y: line.y },
    };
  }
  return { start: { x: line.x, y: line.y }, end: { x: line.x + line.width, y: line.y + line.height } };
}

/** The box and flip that draw a line between two points. Flat and upright lines keep a zero side. */
export function lineFromEndpoints(start: Point, end: Point): LineBounds {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  // A line rises when the end sits above the start, or the start is to the right of the end.
  const flip = width > 0 && height > 0 && (end.x - start.x) * (end.y - start.y) < 0;
  return { x: round(x), y: round(y), width: round(width), height: round(height), flip };
}

/** Move one end of a line, snap that end to the guides, and keep it on the slide. */
export function moveLineEndpoint(
  origin: LineBounds,
  handle: LineHandle,
  delta: Point,
  targets: SnapTargets,
  threshold = SNAP_THRESHOLD,
): Snapped<LineBounds> {
  const ends = lineEndpoints(origin);
  const moving = handle === 'start' ? ends.start : ends.end;
  const fixed = handle === 'start' ? ends.end : ends.start;
  let x = clamp(moving.x + delta.x, 0, 100);
  let y = clamp(moving.y + delta.y, 0, 100);
  const guides: Guide[] = [];
  const snapX = nearest([x], targets.xs, threshold);
  if (snapX) {
    x = snapX.target;
    guides.push({ axis: 'x', at: snapX.target });
  }
  const snapY = nearest([y], targets.ys, threshold);
  if (snapY) {
    y = snapY.target;
    guides.push({ axis: 'y', at: snapY.target });
  }
  const next = handle === 'start' ? lineFromEndpoints({ x, y }, fixed) : lineFromEndpoints(fixed, { x, y });
  return { bounds: { ...origin, ...next }, guides };
}

/** The CSS cursor for a handle, turned with the element's rotation in 45 degree steps. */
export function handleCursor(handle: BoxHandle, rotation = 0): string {
  const order: BoxHandle[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  const cursors = [
    'ns-resize',
    'nesw-resize',
    'ew-resize',
    'nwse-resize',
    'ns-resize',
    'nesw-resize',
    'ew-resize',
    'nwse-resize',
  ];
  const steps = Math.round((((rotation % 360) + 360) % 360) / 45);
  return cursors[(order.indexOf(handle) + steps) % 8];
}

/** Where a box handle sits on the selection outline, as percent of the box. */
export function handlePosition(handle: BoxHandle): Point {
  const x = handle.includes('w') ? 0 : handle.includes('e') ? 100 : 50;
  const y = handle.includes('n') ? 0 : handle.includes('s') ? 100 : 50;
  return { x, y };
}

/** Arrow-key step: one percent, five with Shift. */
export function nudgeStep(shift: boolean) {
  return shift ? 5 : 1;
}

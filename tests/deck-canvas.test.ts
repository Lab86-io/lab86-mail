import { describe, expect, test } from 'bun:test';
import {
  BOX_HANDLES,
  focalFromPointer,
  handleCursor,
  handlePosition,
  lineEndpoints,
  lineFromEndpoints,
  moveBounds,
  moveLineEndpoint,
  nudgeStep,
  percentDelta,
  pointerToPercent,
  resizeBounds,
  snapBounds,
  snapResize,
  snapTargets,
} from '../components/files/editors/deck/canvas-math';
import { formatChartRows, parseChartRows } from '../components/files/editors/deck/chart-data';

const rect = { left: 100, top: 50, width: 960, height: 540 };
const box = { x: 20, y: 20, width: 30, height: 20 };

describe('pointer to slide percent', () => {
  test('pixels convert through the canvas rect; a degenerate rect yields no movement', () => {
    expect(percentDelta(rect, 96, 54)).toEqual({ x: 10, y: 10 });
    expect(percentDelta({ width: 0, height: 0 }, 96, 54)).toEqual({ x: 0, y: 0 });
    expect(pointerToPercent(rect, 100 + 480, 50 + 135)).toEqual({ x: 50, y: 25 });
    expect(pointerToPercent(rect, -1000, 9999)).toEqual({ x: 0, y: 100 });
    expect(focalFromPointer(rect, 100 + 240, 50 + 405)).toEqual({ x: 0.25, y: 0.75 });
  });
});

describe('move and resize', () => {
  test('a move keeps the size and stays inside the slide', () => {
    expect(moveBounds(box, { x: 5.123, y: -2 })).toEqual({ x: 25.12, y: 18, width: 30, height: 20 });
    expect(moveBounds(box, { x: 500, y: 500 })).toEqual({ x: 70, y: 80, width: 30, height: 20 });
    expect(moveBounds(box, { x: -500, y: -500 })).toEqual({ x: 0, y: 0, width: 30, height: 20 });
  });
  test('each handle moves only its own edges and honors the minimum size', () => {
    expect(resizeBounds(box, 'se', { x: 10, y: 5 })).toEqual({ x: 20, y: 20, width: 40, height: 25 });
    expect(resizeBounds(box, 'nw', { x: 10, y: 5 })).toEqual({ x: 30, y: 25, width: 20, height: 15 });
    expect(resizeBounds(box, 'e', { x: 10, y: 99 })).toEqual({ x: 20, y: 20, width: 40, height: 20 });
    expect(resizeBounds(box, 'n', { x: 99, y: -10 })).toEqual({ x: 20, y: 10, width: 30, height: 30 });
    // Pull the right edge past the left edge: the box keeps one percent.
    expect(resizeBounds(box, 'w', { x: 100, y: 0 })).toEqual({ x: 49, y: 20, width: 1, height: 20 });
    expect(resizeBounds(box, 's', { x: 0, y: 200 })).toEqual({ x: 20, y: 20, width: 30, height: 80 });
    for (const handle of BOX_HANDLES) {
      const next = resizeBounds(box, handle, { x: 3, y: 3 });
      expect(next.x + next.width).toBeLessThanOrEqual(100);
      expect(next.y + next.height).toBeLessThanOrEqual(100);
      expect(next.width).toBeGreaterThanOrEqual(1);
    }
    // Lines may be flat.
    expect(resizeBounds({ x: 10, y: 50, width: 60, height: 0 }, 'e', { x: -60, y: 0 }, 0)).toEqual({
      x: 10,
      y: 50,
      width: 0,
      height: 0,
    });
  });
  test('handle geometry: positions on the outline and cursors that turn with rotation', () => {
    expect(handlePosition('nw')).toEqual({ x: 0, y: 0 });
    expect(handlePosition('e')).toEqual({ x: 100, y: 50 });
    expect(handlePosition('s')).toEqual({ x: 50, y: 100 });
    expect(handleCursor('e')).toBe('ew-resize');
    expect(handleCursor('e', 90)).toBe('ns-resize');
    expect(handleCursor('se', -45)).toBe('ew-resize');
    expect(nudgeStep(false)).toBe(1);
    expect(nudgeStep(true)).toBe(5);
  });
});

describe('snap guides', () => {
  const targets = snapTargets([{ x: 60, y: 10, width: 20, height: 30 }]);
  test('targets are the slide edges and center plus the other elements edges and centers', () => {
    expect(targets.xs).toEqual([0, 50, 60, 70, 80, 100]);
    expect(targets.ys).toEqual([0, 10, 25, 40, 50, 100]);
  });
  test('an edge within one percent snaps and reports a guide; farther edges do not', () => {
    const near = snapBounds({ x: 29.4, y: 3, width: 30, height: 20 }, targets);
    // The right edge (59.4) is the closest candidate to 60; no vertical edge is near a guide.
    expect(near.bounds).toEqual({ x: 30, y: 3, width: 30, height: 20 });
    expect(near.guides).toEqual([{ axis: 'x', at: 60 }]);
    const far = snapBounds({ x: 27, y: 3, width: 30, height: 20 }, targets);
    expect(far.bounds).toEqual({ x: 27, y: 3, width: 30, height: 20 });
    expect(far.guides).toEqual([]);
  });
  test('the center snaps to the slide center on both axes', () => {
    const centered = snapBounds({ x: 35.5, y: 40.6, width: 30, height: 20 }, snapTargets([]));
    expect(centered.bounds).toEqual({ x: 35, y: 40, width: 30, height: 20 });
    expect(centered.guides).toEqual([
      { axis: 'x', at: 50 },
      { axis: 'y', at: 50 },
    ]);
  });
  test('a snapped move never pushes the box off the slide', () => {
    const edge = snapBounds({ x: 70.5, y: 0.4, width: 30, height: 20 }, targets);
    expect(edge.bounds.x + edge.bounds.width).toBeLessThanOrEqual(100);
    expect(edge.bounds.y).toBe(0);
  });
  test('a resize snaps only the edges its handle moves', () => {
    const east = snapResize({ x: 20, y: 5, width: 39.5, height: 20 }, 'e', targets);
    expect(east.bounds).toEqual({ x: 20, y: 5, width: 40, height: 20 });
    expect(east.guides).toEqual([{ axis: 'x', at: 60 }]);
    const west = snapResize({ x: 49.5, y: 5, width: 40, height: 20 }, 'w', targets);
    expect(west.bounds).toEqual({ x: 50, y: 5, width: 39.5, height: 20 });
    // The top edge is far from any guide, so a north handle leaves it alone.
    const north = snapResize({ x: 20, y: 5, width: 39.5, height: 20 }, 'n', targets);
    expect(north.bounds).toEqual({ x: 20, y: 5, width: 39.5, height: 20 });
    expect(north.guides).toEqual([]);
    // A snap that would collapse the box is refused.
    const tiny = snapResize({ x: 59.5, y: 5, width: 1, height: 20 }, 'e', targets, 1, 1);
    expect(tiny.bounds.width).toBeGreaterThanOrEqual(1);
  });
});

describe('line ends', () => {
  test('endpoints and boxes round-trip, including rising lines and flat lines', () => {
    const falling = { x: 10, y: 20, width: 50, height: 30 };
    expect(lineEndpoints(falling)).toEqual({ start: { x: 10, y: 20 }, end: { x: 60, y: 50 } });
    expect(lineFromEndpoints({ x: 10, y: 20 }, { x: 60, y: 50 })).toEqual({ ...falling, flip: false });
    const rising = { x: 10, y: 20, width: 50, height: 30, flip: true };
    expect(lineEndpoints(rising)).toEqual({ start: { x: 10, y: 50 }, end: { x: 60, y: 20 } });
    expect(lineFromEndpoints({ x: 10, y: 50 }, { x: 60, y: 20 })).toEqual(rising);
    expect(lineFromEndpoints({ x: 10, y: 50 }, { x: 60, y: 50 })).toEqual({
      x: 10,
      y: 50,
      width: 50,
      height: 0,
      flip: false,
    });
  });
  test('moving one end keeps the other fixed, snaps, and stays on the slide', () => {
    const targets = snapTargets([]);
    const moved = moveLineEndpoint({ x: 10, y: 50, width: 60, height: 0 }, 'end', { x: 29.6, y: 0 }, targets);
    expect(moved.bounds).toEqual({ x: 10, y: 50, width: 90, height: 0, flip: false });
    // The end reached the right edge and already sits on the horizontal center line.
    expect(moved.guides).toEqual([
      { axis: 'x', at: 100 },
      { axis: 'y', at: 50 },
    ]);
    const crossed = moveLineEndpoint(
      { x: 10, y: 50, width: 60, height: 0 },
      'start',
      { x: 80, y: -20 },
      targets,
    );
    // The start now sits to the right of, and above, the end: a rising line.
    expect(crossed.bounds).toEqual({ x: 70, y: 30, width: 20, height: 20, flip: true });
    const clamped = moveLineEndpoint(
      { x: 10, y: 50, width: 60, height: 0 },
      'end',
      { x: 500, y: 500 },
      targets,
    );
    expect(clamped.bounds.x + clamped.bounds.width).toBeLessThanOrEqual(100);
    expect(clamped.bounds.y + clamped.bounds.height).toBeLessThanOrEqual(100);
  });
});

describe('chart rows as text', () => {
  test('format and parse round-trip for one and several series', () => {
    const one = { categories: ['Q1', 'Q2'], series: [{ name: 'Spend', values: [180, 240] }] };
    expect(formatChartRows(one)).toBe('Q1, 180\nQ2, 240');
    expect(parseChartRows(formatChartRows(one), ['Spend'])).toEqual({ rows: one });
    const two = {
      categories: ['A', 'B'],
      series: [
        { name: 'Now', values: [1, 2] },
        { name: 'June', values: [3, 4.5] },
      ],
    };
    expect(formatChartRows(two)).toBe('A, 1, 3\nB, 2, 4.5');
    expect(parseChartRows(formatChartRows(two), ['Now', 'June'])).toEqual({ rows: two });
  });
  test('extra columns get a numbered series, short rows read as zero, units are stripped', () => {
    const result = parseChartRows('A, 1, 3\nB, 2\nC, $4k, 6', ['Now']);
    expect(result).toEqual({
      rows: {
        categories: ['A', 'B', 'C'],
        series: [
          { name: 'Now', values: [1, 2, 4] },
          { name: 'Series 2', values: [3, 0, 6] },
        ],
      },
    });
  });
  test('problems are reported by line', () => {
    expect(parseChartRows('', [])).toEqual({ error: 'Add at least one line: label, value.' });
    expect(parseChartRows('Q1', [])).toEqual({ error: 'Line 1 needs a value after the label.' });
    expect(parseChartRows(', 4', [])).toEqual({ error: 'Line 1 needs a label before the first comma.' });
    expect(parseChartRows('Q1, 4\nQ2, many', [])).toEqual({ error: 'Line 2: "many" is not a number.' });
  });
});

import { describe, expect, test } from 'bun:test';
import { dockGlyphScale, dockPointerDistance, dockTileSize } from '../lib/dock-magnify';

const geometry = { baseSize: 32, magnifiedSize: 44, range: 96 };

describe('dockTileSize', () => {
  test('pointer dead-center yields the magnified size', () => {
    expect(dockTileSize({ ...geometry, distance: 0 })).toBe(44);
  });

  test('at or beyond the range the tile rests at base size', () => {
    expect(dockTileSize({ ...geometry, distance: 96 })).toBe(32);
    expect(dockTileSize({ ...geometry, distance: -96 })).toBe(32);
    expect(dockTileSize({ ...geometry, distance: 500 })).toBe(32);
  });

  test('interpolates linearly between center and range', () => {
    expect(dockTileSize({ ...geometry, distance: 48 })).toBe(38); // halfway
    expect(dockTileSize({ ...geometry, distance: 24 })).toBe(41); // quarter out
  });

  test('is symmetric for tiles above and below the pointer', () => {
    expect(dockTileSize({ ...geometry, distance: -30 })).toBe(dockTileSize({ ...geometry, distance: 30 }));
  });

  test('the pointer-left sentinel (Infinity) and NaN rest at base size', () => {
    expect(dockTileSize({ ...geometry, distance: Infinity })).toBe(32);
    expect(dockTileSize({ ...geometry, distance: -Infinity })).toBe(32);
    expect(dockTileSize({ ...geometry, distance: NaN })).toBe(32);
  });

  test('a zero or negative range disables magnification', () => {
    expect(dockTileSize({ ...geometry, range: 0, distance: 0 })).toBe(32);
    expect(dockTileSize({ ...geometry, range: -10, distance: 0 })).toBe(32);
  });

  test('supports a magnified size below base (shrink docks) with the same curve', () => {
    expect(dockTileSize({ baseSize: 40, magnifiedSize: 20, range: 100, distance: 0 })).toBe(20);
    expect(dockTileSize({ baseSize: 40, magnifiedSize: 20, range: 100, distance: 50 })).toBe(30);
  });
});

describe('dockGlyphScale', () => {
  test('rides the tile size: 1 at rest, magnified/base under the cursor', () => {
    expect(dockGlyphScale(32, 32)).toBe(1);
    expect(dockGlyphScale(44, 32)).toBe(44 / 32);
    expect(dockGlyphScale(38, 32)).toBe(38 / 32); // mid-spring frame
  });

  test('degenerate inputs resolve to 1, never a collapsed or exploded glyph', () => {
    expect(dockGlyphScale(Infinity, 32)).toBe(1);
    expect(dockGlyphScale(NaN, 32)).toBe(1);
    expect(dockGlyphScale(44, 0)).toBe(1);
    expect(dockGlyphScale(44, -8)).toBe(1);
  });
});

describe('dockPointerDistance', () => {
  test('measures signed distance to the tile center', () => {
    // Tile from y=100 to y=140 → center 120.
    expect(dockPointerDistance(120, 100, 40)).toBe(0);
    expect(dockPointerDistance(150, 100, 40)).toBe(30);
    expect(dockPointerDistance(90, 100, 40)).toBe(-30);
  });

  test('a non-finite pointer stays Infinity so the size curve rests', () => {
    expect(dockPointerDistance(Infinity, 100, 40)).toBe(Infinity);
    expect(dockPointerDistance(NaN, 100, 40)).toBe(Infinity);
  });
});

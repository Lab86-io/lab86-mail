import { describe, expect, test } from 'bun:test';
import { artInkColor, contrastRatio, hex, paletteFromPixels } from '../lib/mail/art-palette';
import { ART_POOL } from '../lib/mail/daily-art-pool';
import { csvRecords } from '../scripts/art-pool-csv';

describe('image palette and printed ink', () => {
  test('extracts weighted image colors deterministically, including flat images', () => {
    const pixels: [number, number, number][] = [
      ...Array(80).fill([180, 40, 30]),
      ...Array(20).fill([20, 60, 190]),
    ];
    const swatches = paletteFromPixels(pixels, 6);
    expect(swatches).toEqual(paletteFromPixels(pixels, 6));
    expect(swatches[0].share).toBe(0.8);
    expect(hex(swatches[0].rgb)).toBe('#b4281e');
    expect(paletteFromPixels([], 6)).toEqual([]);
    expect(paletteFromPixels([[80, 80, 80]], 6)).toEqual([{ rgb: [80, 80, 80], share: 1 }]);
  });

  test('ink changes with the painting and retains neutral tones for grayscale art', () => {
    expect(artInkColor(['#c04030'])).not.toBe(artInkColor(['#3050c0']));
    const neutral = artInkColor(['#707070']);
    expect(neutral.slice(1, 3)).toBe(neutral.slice(3, 5));
    expect(neutral.slice(3, 5)).toBe(neutral.slice(5, 7));
    expect(artInkColor(['invalid'])).toBe(artInkColor([]));
  });

  test('every painting stays above 4.5:1 even in the darkest texture flecks', () => {
    for (const palette of [
      ...ART_POOL.map((art) => art.palette),
      [],
      ['#000000'],
      ['#ffffff'],
      ['#ff0000'],
      ['#0000ff'],
    ]) {
      const color = artInkColor(palette);
      const darkest = hex(
        [1, 3, 5].map((i) => Math.floor(Number.parseInt(color.slice(i, i + 2), 16) * 0.94)) as [
          number,
          number,
          number,
        ],
      );
      expect(contrastRatio(darkest, '#666666')).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('museum CSV preserves embedded commas, newlines and quotes', () => {
    expect(csvRecords('id,title,artist\r\n1,"Harbor, evening","A ""B"""\r\n2,"Two\nlines",C')).toEqual([
      { id: '1', title: 'Harbor, evening', artist: 'A "B"' },
      { id: '2', title: 'Two\nlines', artist: 'C' },
    ]);
  });
});

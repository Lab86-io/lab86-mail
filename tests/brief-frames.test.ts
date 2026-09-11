import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  BRIEF_FRAMES,
  briefFrameById,
  briefFrameCreditLine,
  briefFrameForDay,
  briefFrameStyle,
} from '../lib/brief/frames';
import { ART_STYLES } from '../lib/mail/art-style';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('brief picture frames', () => {
  test('every frame ships its asset with a plausible border-image slice', () => {
    const ids = new Set<string>();
    for (const frame of BRIEF_FRAMES) {
      expect(ids.has(frame.id)).toBe(false);
      ids.add(frame.id);
      expect(existsSync(join(process.cwd(), 'public', frame.src))).toBe(true);
      const [top, right, bottom, left] = frame.slice;
      // Each side must leave an opening; two sides cannot meet in the middle.
      expect(top + bottom).toBeLessThan(frame.height);
      expect(left + right).toBeLessThan(frame.width);
      for (const side of frame.slice) expect(side).toBeGreaterThan(0);
      expect(frame.widthScale).toBeGreaterThanOrEqual(0.3);
      expect(frame.widthScale).toBeLessThanOrEqual(1.2);
      expect(frame.credit.length).toBeGreaterThan(0);
      expect(frame.license.length).toBeGreaterThan(0);
    }
    expect(BRIEF_FRAMES.length).toBe(21);
    expect(BRIEF_FRAMES.filter((frame) => frame.family === 'gothic')).toHaveLength(6);
    expect(BRIEF_FRAMES.filter((frame) => frame.family === 'modern')).toHaveLength(5);
    expect(BRIEF_FRAMES.filter((frame) => frame.family === 'art-deco')).toHaveLength(5);
  });

  test('the day picks one frame and keeps it for the whole day', () => {
    const morning = Date.UTC(2026, 8, 10, 13, 0);
    const evening = Date.UTC(2026, 8, 10, 23, 30);
    expect(briefFrameForDay(morning, 'UTC', 'modern').id).toBe(briefFrameForDay(evening, 'UTC', 'modern').id);
    // The zone decides the day. Late evening in UTC is still the same day in
    // Los Angeles, but 03:00 UTC is the previous day there.
    const smallHours = Date.UTC(2026, 8, 11, 3, 0);
    expect(briefFrameForDay(smallHours, 'America/Los_Angeles', 'modern').id).toBe(
      briefFrameForDay(evening, 'America/Los_Angeles', 'modern').id,
    );
  });

  test('a run of days reaches every frame', () => {
    const seen = new Set<string>();
    const start = Date.UTC(2026, 0, 1, 12, 0);
    for (const style of ART_STYLES) {
      for (let day = 0; day < 120; day += 1) {
        const frame = briefFrameForDay(start + day * DAY_MS, 'UTC', style);
        expect(frame.styles).toContain(style);
        seen.add(frame.id);
      }
    }
    expect(seen.size).toBe(BRIEF_FRAMES.length);
  });

  test('lookups, styles, and the credit line', () => {
    expect(briefFrameById('robert-gilt')?.id).toBe('robert-gilt');
    expect(briefFrameById('no-such-frame')).toBeNull();
    expect(briefFrameById(null)).toBeNull();
    const frame = briefFrameById('david-gilt');
    if (!frame) throw new Error('missing frame');
    const style = briefFrameStyle(frame) as Record<string, string>;
    expect(style['--brief-frame-src']).toBe('url("/frames/david-gilt.png")');
    expect(style['--brief-frame-slice']).toBe(frame.slice.join(' '));
    expect(style['--brief-frame-scale']).toBe('1');
    expect(briefFrameCreditLine(frame)).toContain('Frame: ');
    expect(briefFrameCreditLine(frame)).toContain(frame.credit);
  });
});

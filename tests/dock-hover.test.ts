import { describe, expect, test } from 'bun:test';
import {
  DOCK_GLOW_FADE,
  DOCK_GLOW_SPRING,
  dockGlowMotion,
  dockHoverGlow,
  dockHoverRing,
  dockLabelLeft,
} from '../lib/dock-hover';

describe('dockHoverGlow', () => {
  test('builds a theme-accent radial that ends transparent (no hard rectangle)', () => {
    const glow = dockHoverGlow();
    expect(glow.startsWith('radial-gradient(closest-side')).toBe(true);
    expect(glow).toContain('color-mix(in oklab, var(--color-accent) 30%, transparent)');
    expect(glow.endsWith('transparent)')).toBe(true);
  });

  test('accepts a custom accent expression', () => {
    expect(dockHoverGlow('var(--color-selected)')).toContain('var(--color-selected) 30%');
  });
});

describe('dockHoverRing', () => {
  test('is a soft 1px accent ring over the theme lift shadow', () => {
    const ring = dockHoverRing();
    expect(ring.startsWith('0 0 0 1px color-mix(in oklab, var(--color-accent) 32%, transparent)')).toBe(true);
    expect(ring).toContain('var(--shadow-soft)');
  });

  test('accepts a custom accent expression', () => {
    expect(dockHoverRing('red')).toContain('red 32%');
  });
});

describe('dockGlowMotion', () => {
  test('spring curve rides the dock magnification spring', () => {
    const shown = dockGlowMotion(true, false, 'spring');
    expect(shown.animate).toEqual({ opacity: 1, scale: 1 });
    expect(shown.transition).toEqual(DOCK_GLOW_SPRING);
  });

  test('hidden state fades out and shrinks slightly', () => {
    const hidden = dockGlowMotion(false, false);
    expect(hidden.animate).toEqual({ opacity: 0, scale: 0.75 });
  });

  test("fade curve is Chamaac's 0.2s tween", () => {
    expect(dockGlowMotion(true, false, 'fade').transition).toEqual(DOCK_GLOW_FADE);
    expect(DOCK_GLOW_FADE.duration).toBe(0.2);
  });

  test('reduced motion: instant state change, no scale swell', () => {
    const shown = dockGlowMotion(true, true, 'spring');
    expect(shown.animate).toEqual({ opacity: 1, scale: 1 });
    expect(shown.transition).toEqual({ duration: 0 });
    const hidden = dockGlowMotion(false, true, 'fade');
    expect(hidden.animate).toEqual({ opacity: 0, scale: 1 });
    expect(hidden.transition).toEqual({ duration: 0 });
  });
});

describe('dockLabelLeft', () => {
  test('labels align to the rail edge plus a gap, not the tile edge', () => {
    // Rail right at 48, resting tile right at 40 → label clears the rail.
    expect(dockLabelLeft(40, 48)).toBe(60);
  });

  test('a magnified tile that spills past the rail still gets the gap', () => {
    expect(dockLabelLeft(52, 48)).toBe(64);
  });

  test('falls back to the tile edge when the rail was not measurable', () => {
    expect(dockLabelLeft(40, null)).toBe(52);
    expect(dockLabelLeft(40, undefined)).toBe(52);
    expect(dockLabelLeft(40, Number.NaN)).toBe(52);
  });

  test('custom gap', () => {
    expect(dockLabelLeft(40, 48, 20)).toBe(68);
  });
});

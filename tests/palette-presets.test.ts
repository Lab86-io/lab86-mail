import { describe, expect, it } from 'bun:test';
import {
  brillianceFromChroma,
  clampBrilliance,
  DEFAULT_ACCENT_2_CHROMA,
  DEFAULT_ACCENT_2_HUE,
  DEFAULT_ACCENT_3_CHROMA,
  DEFAULT_ACCENT_3_HUE,
  DEFAULT_ACCENT_CHROMA,
  DEFAULT_ACCENT_HUE,
  DEFAULT_BG_HUE,
  DEFAULT_SURFACE_TINT,
  MAX_BRILLIANCE,
  MIN_BRILLIANCE,
  nearestWheelStop,
  PALETTE_CHORD,
  paletteStop,
  rotateHue,
  WHEEL_STOP_COUNT,
} from '../lib/theme/palette-presets';

/* Recompute the OKLCH derivations from app/globals.css and hold the wheel to
 * the bar the panel promises: every one of the 20 stops, across the whole
 * brilliance range, keeps all THREE accents readable as text (>= 4.5:1)
 * against that stop's own paper in light AND dark — the mathematical
 * guarantee that the scrubber can never land on an illegible palette. The
 * depth ladder must also stay monotonic (well < paper < card < float) at
 * every Depth setting. */

// OKLCH -> gamut-clamped sRGB (standard OKLab matrices).
function oklchToSrgb(L: number, C: number, H: number): [number, number, number] {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((x) => {
    const gamma = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, gamma));
  }) as [number, number, number];
}

function relativeLuminance([r, g, b]: [number, number, number]) {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function hueDistance(a: number, b: number) {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return Math.min(d, 360 - d);
}

// The same surface/accent formulas globals.css derives from the seeds.
function lightBg(bgHue: number, tint: number) {
  return oklchToSrgb(0.977 - tint * 0.012, 0.005 + tint * 0.022, bgHue);
}
function darkBg(bgHue: number, tint: number) {
  return oklchToSrgb(0.145 + tint * 0.14, 0.006 + tint * 0.04, bgHue);
}
function lightAccent(hue: number, chroma: number) {
  return oklchToSrgb(0.45, chroma, hue);
}
function darkAccent(hue: number, chroma: number) {
  return oklchToSrgb(0.73, chroma * 0.78, hue);
}

// The depth ladder's lightness terms (globals.css), by spread and tint.
function lightLadder(spread: number, tint: number) {
  return {
    well: 0.977 - 0.022 * spread - tint * 0.013,
    paper: 0.977 - tint * 0.012,
    card: Math.min(0.998, 0.977 + 0.018 * spread - tint * 0.008),
    float: Math.min(0.999, 0.977 + 0.022 * spread - tint * 0.006),
  };
}
function darkLadder(spread: number, tint: number) {
  return {
    well: Math.max(0.09, 0.145 + tint * 0.14 - 0.024 * spread),
    paper: 0.145 + tint * 0.14,
    card: 0.145 + tint * 0.14 + 0.075 * spread,
    float: 0.145 + tint * 0.14 + 0.13 * spread,
  };
}

describe('palette chord', () => {
  it('anchors stop 0 on the defaults globals.css carries', () => {
    const stop = paletteStop(0, 1);
    expect(stop.hue).toBe(DEFAULT_ACCENT_HUE);
    expect(stop.chroma).toBeCloseTo(DEFAULT_ACCENT_CHROMA, 5);
    expect(stop.hue2).toBe(DEFAULT_ACCENT_2_HUE);
    expect(stop.chroma2).toBeCloseTo(DEFAULT_ACCENT_2_CHROMA, 5);
    expect(stop.hue3).toBe(DEFAULT_ACCENT_3_HUE);
    expect(stop.chroma3).toBeCloseTo(DEFAULT_ACCENT_3_CHROMA, 5);
    expect(stop.bgHue).toBe(DEFAULT_BG_HUE);
    expect(stop.surfaceTint).toBeCloseTo(DEFAULT_SURFACE_TINT, 5);
  });

  it('keeps the three voices genuinely distinct hues at every stop', () => {
    for (let index = 0; index < WHEEL_STOP_COUNT; index += 1) {
      const stop = paletteStop(index);
      expect(hueDistance(stop.hue, stop.hue2)).toBeGreaterThanOrEqual(60);
      expect(hueDistance(stop.hue, stop.hue3)).toBeGreaterThanOrEqual(45);
      expect(hueDistance(stop.hue2, stop.hue3)).toBeGreaterThanOrEqual(45);
    }
  });

  it('wraps hues and rounds stops consistently', () => {
    expect(rotateHue(350, 20)).toBe(10);
    expect(rotateHue(10, -20)).toBe(350);
    for (let index = 0; index < WHEEL_STOP_COUNT; index += 1) {
      expect(nearestWheelStop(paletteStop(index).hue)).toBe(index);
    }
  });

  it('clamps brilliance and recovers it from the applied chroma', () => {
    expect(clampBrilliance(0)).toBe(MIN_BRILLIANCE);
    expect(clampBrilliance(99)).toBe(MAX_BRILLIANCE);
    expect(clampBrilliance(Number.NaN)).toBe(1);
    expect(brillianceFromChroma(DEFAULT_ACCENT_CHROMA)).toBeCloseTo(1, 5);
    const dim = paletteStop(3, 0.5);
    expect(brillianceFromChroma(dim.chroma)).toBeCloseTo(0.5, 5);
  });

  it('holds all three accents to >= 4.5:1 on the paper at every stop and brilliance, light and dark', () => {
    for (let index = 0; index < WHEEL_STOP_COUNT; index += 1) {
      for (const brilliance of [MIN_BRILLIANCE, 0.6, 1, MAX_BRILLIANCE]) {
        const stop = paletteStop(index, brilliance);
        const paperLight = lightBg(stop.bgHue, stop.surfaceTint);
        const paperDark = darkBg(stop.bgHue, stop.surfaceTint);
        for (const [hue, chroma] of [
          [stop.hue, stop.chroma],
          [stop.hue2, stop.chroma2],
          [stop.hue3, stop.chroma3],
        ] as const) {
          expect(contrastRatio(lightAccent(hue, chroma), paperLight)).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(darkAccent(hue, chroma), paperDark)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

describe('depth ladder', () => {
  it('stays monotonic (well < paper < card < float) across the Depth range in both modes', () => {
    for (const spread of [0.4, 0.7, 1, 1.3, 1.6]) {
      for (const tint of [0, DEFAULT_SURFACE_TINT, 0.4]) {
        const light = lightLadder(spread, tint);
        expect(light.well).toBeLessThan(light.paper);
        expect(light.paper).toBeLessThan(light.card);
        expect(light.card).toBeLessThan(light.float);
        const dark = darkLadder(spread, tint);
        expect(dark.well).toBeLessThan(dark.paper);
        expect(dark.paper).toBeLessThan(dark.card);
        expect(dark.card).toBeLessThan(dark.float);
      }
    }
  });

  it('reproduces the legacy surfaces exactly at Depth 1, tint 0', () => {
    const light = lightLadder(1, 0);
    expect(light.paper).toBeCloseTo(0.977, 5);
    expect(light.card).toBeCloseTo(0.995, 5);
    const dark = darkLadder(1, 0);
    expect(dark.paper).toBeCloseTo(0.145, 5);
    expect(dark.card).toBeCloseTo(0.22, 5);
  });
});

describe('globals.css carries the same seeds and derivations', () => {
  it('matches the chord defaults and depth tokens', async () => {
    const css = await Bun.file(new URL('../app/globals.css', import.meta.url)).text();
    expect(css).toContain(`--accent-2-hue: ${DEFAULT_ACCENT_2_HUE};`);
    expect(css).toContain(`--accent-2-chroma: ${DEFAULT_ACCENT_2_CHROMA};`);
    expect(css).toContain(`--accent-3-hue: ${DEFAULT_ACCENT_3_HUE};`);
    expect(css).toContain(`--accent-3-chroma: ${DEFAULT_ACCENT_3_CHROMA};`);
    expect(css).toContain('--depth-spread: 1;');
    expect(css).toContain('--color-accent-3: oklch(0.45 var(--accent-3-chroma) var(--accent-3-hue))');
    expect(css).toContain(
      '--color-accent-3: oklch(0.73 calc(var(--accent-3-chroma) * 0.78) var(--accent-3-hue))',
    );
    expect(css).toContain('--color-surface-well');
    expect(css).toContain('--color-surface-float');
    // The chord offsets encoded in the presets module stay in sync with the
    // default seeds above.
    expect(rotateHue(DEFAULT_ACCENT_HUE, PALETTE_CHORD.accent2Offset)).toBe(DEFAULT_ACCENT_2_HUE);
    expect(rotateHue(DEFAULT_ACCENT_HUE, PALETTE_CHORD.accent3Offset)).toBe(DEFAULT_ACCENT_3_HUE);
    expect(rotateHue(DEFAULT_ACCENT_HUE, PALETTE_CHORD.paperOffset)).toBe(DEFAULT_BG_HUE);
  });
});

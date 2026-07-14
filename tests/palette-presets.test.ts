import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_ACCENT_2_CHROMA,
  DEFAULT_ACCENT_2_HUE,
  DEFAULT_ACCENT_CHROMA,
  DEFAULT_ACCENT_HUE,
  PALETTE_PRESETS,
} from '../lib/theme/palette-presets';

/* Recompute the OKLCH derivations from app/globals.css and hold every curated
 * accent pair to the same bar the picker promises: readable as text (>= 4.5:1)
 * against the preset's own paper tint in light AND dark, and genuinely a pair
 * (two distinct hues), not one accent twice. */

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

// The same surface/accent formulas globals.css derives from a preset's seeds.
function lightBg(bgHue: number | null, tint: number) {
  return oklchToSrgb(0.977 - tint * 0.012, 0.005 + tint * 0.022, bgHue ?? 156);
}
function darkBg(bgHue: number | null, tint: number) {
  return oklchToSrgb(0.145 + tint * 0.14, 0.006 + tint * 0.04, bgHue ?? 156);
}
function lightAccent(hue: number, chroma: number) {
  return oklchToSrgb(0.45, chroma, hue);
}
function darkAccent(hue: number, chroma: number) {
  return oklchToSrgb(0.73, chroma * 0.78, hue);
}

describe('palette presets', () => {
  it('defines both accents on every preset', () => {
    expect(PALETTE_PRESETS.length).toBeGreaterThan(0);
    for (const preset of PALETTE_PRESETS) {
      expect(Number.isFinite(preset.hue)).toBe(true);
      expect(Number.isFinite(preset.hue2)).toBe(true);
      expect(preset.chroma).toBeGreaterThan(0);
      expect(preset.chroma2).toBeGreaterThan(0);
    }
  });

  it('pairs two genuinely different hues, not the accent twice', () => {
    for (const preset of PALETTE_PRESETS) {
      expect(hueDistance(preset.hue, preset.hue2)).toBeGreaterThanOrEqual(60);
    }
  });

  it('keeps preset names and pairings unique', () => {
    const names = PALETTE_PRESETS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    const pairs = PALETTE_PRESETS.map((p) => `${p.hue2}/${p.chroma2}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('holds both accents to text contrast >= 4.5:1 on the preset paper, light and dark', () => {
    for (const preset of PALETTE_PRESETS) {
      const paperLight = lightBg(preset.bgHue, preset.surfaceTint);
      const paperDark = darkBg(preset.bgHue, preset.surfaceTint);
      for (const [hue, chroma] of [
        [preset.hue, preset.chroma],
        [preset.hue2, preset.chroma2],
      ] as const) {
        expect(contrastRatio(lightAccent(hue, chroma), paperLight)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(darkAccent(hue, chroma), paperDark)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('matches the CSS defaults for the Forest preset', async () => {
    const forest = PALETTE_PRESETS[0];
    expect(forest.name).toBe('Forest');
    expect(forest.hue).toBe(DEFAULT_ACCENT_HUE);
    expect(forest.chroma).toBe(DEFAULT_ACCENT_CHROMA);
    expect(forest.hue2).toBe(DEFAULT_ACCENT_2_HUE);
    expect(forest.chroma2).toBe(DEFAULT_ACCENT_2_CHROMA);
    // globals.css :root carries the same seeds, so a null (auto) accent-2
    // reproduces the Forest pairing.
    const css = await Bun.file(new URL('../app/globals.css', import.meta.url)).text();
    expect(css).toContain(`--accent-2-hue: ${DEFAULT_ACCENT_2_HUE};`);
    expect(css).toContain(`--accent-2-chroma: ${DEFAULT_ACCENT_2_CHROMA};`);
    expect(css).toContain('--color-accent-2: oklch(0.45 var(--accent-2-chroma) var(--accent-2-hue))');
    expect(css).toContain(
      '--color-accent-2: oklch(0.73 calc(var(--accent-2-chroma) * 0.78) var(--accent-2-hue))',
    );
  });
});

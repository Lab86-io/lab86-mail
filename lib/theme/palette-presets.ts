/* The theme palette is one mathematical object: a three-accent chord seated on
 * a paper tint, rotated around the OKLCH hue wheel. The chord fixes the hue
 * RELATIONSHIPS (primary accent at the wheel angle, the editorial second voice
 * -111°, the highlight third voice +94°, the paper seat -61°) plus a chroma
 * per role; the wheel in the theme panel scrubs that whole object through 20
 * detented stops across the spectrum, and "brilliance" scales every chroma and
 * the paper tint together (in = quiet/near-mono, out = vivid).
 *
 * Lightness never varies per stop — light mode holds accents at L 0.45
 * (text-safe on paper) and dark mode at L 0.73 with damped chroma (the
 * derivations live in app/globals.css) — so hierarchy and contrast survive any
 * wheel position. tests/palette-presets.test.ts sweeps every stop and the
 * brilliance range in both modes and holds all three accents to >= 4.5:1
 * against the rotated paper.
 *
 * Voice contract (60/30/10 — neutral surfaces dominate, accents annotate):
 *   accent   — action voice: buttons, links, toggles, selection.
 *   accent-2 — editorial voice: kickers, section rules, asides, masthead.
 *   accent-3 — highlight voice: badges, lanes, stat deltas, data pops.
 * The depth ladder (well / paper / card / float) derives from the paper seat
 * in globals.css and follows the wheel automatically.
 */

export const DEFAULT_ACCENT_HUE = 156;
export const DEFAULT_ACCENT_CHROMA = 0.09;
// The chord's second voice: Forest's terracotta. globals.css carries the same
// values as the --accent-2-hue/--accent-2-chroma defaults.
export const DEFAULT_ACCENT_2_HUE = 45;
export const DEFAULT_ACCENT_2_CHROMA = 0.11;
// Third voice: a slate blue against the forest/terracotta pair; mirrored by
// the --accent-3-hue/--accent-3-chroma defaults in globals.css.
export const DEFAULT_ACCENT_3_HUE = 250;
export const DEFAULT_ACCENT_3_CHROMA = 0.08;
export const DEFAULT_BG_HUE = 95;
export const DEFAULT_SURFACE_TINT = 0.22;

/** Hue offsets (degrees) and per-role chromas that define the chord shape. */
export const PALETTE_CHORD = {
  accent2Offset: DEFAULT_ACCENT_2_HUE - DEFAULT_ACCENT_HUE, // -111
  accent3Offset: DEFAULT_ACCENT_3_HUE - DEFAULT_ACCENT_HUE, // +94
  paperOffset: DEFAULT_BG_HUE - DEFAULT_ACCENT_HUE, // -61
  chroma: DEFAULT_ACCENT_CHROMA,
  chroma2: DEFAULT_ACCENT_2_CHROMA,
  chroma3: DEFAULT_ACCENT_3_CHROMA,
  surfaceTint: DEFAULT_SURFACE_TINT,
} as const;

export const WHEEL_STOP_COUNT = 20;
export const WHEEL_STEP = 360 / WHEEL_STOP_COUNT;
export const MIN_BRILLIANCE = 0.25;
export const MAX_BRILLIANCE = 1.5;
// OKLCH chroma bounds: the floor keeps a whisper of the hue at minimum
// brilliance (near-mono, not gray); the ceiling matches the fine-tune slider.
const MIN_CHROMA = 0.012;
const MAX_CHROMA = 0.16;
const MAX_SURFACE_TINT = 0.4;

export type PaletteStop = {
  /** Primary accent seed (action voice). */
  hue: number;
  chroma: number;
  /** Second accent seed (editorial voice). */
  hue2: number;
  chroma2: number;
  /** Third accent seed (highlight voice). */
  hue3: number;
  chroma3: number;
  /** Paper seat; the whole depth ladder derives from it. */
  bgHue: number;
  surfaceTint: number;
};

export function rotateHue(hue: number, delta: number) {
  return (((hue + delta) % 360) + 360) % 360;
}

export function clampBrilliance(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_BRILLIANCE, Math.max(MIN_BRILLIANCE, value));
}

/** The full palette object at a wheel stop. Stop 0 is the Forest default. */
export function paletteStop(index: number, brilliance = 1): PaletteStop {
  const b = clampBrilliance(brilliance);
  const hue = rotateHue(DEFAULT_ACCENT_HUE, index * WHEEL_STEP);
  const scaled = (chroma: number) => Math.min(MAX_CHROMA, Math.max(MIN_CHROMA, chroma * b));
  return {
    hue,
    chroma: scaled(PALETTE_CHORD.chroma),
    hue2: rotateHue(hue, PALETTE_CHORD.accent2Offset),
    chroma2: scaled(PALETTE_CHORD.chroma2),
    hue3: rotateHue(hue, PALETTE_CHORD.accent3Offset),
    chroma3: scaled(PALETTE_CHORD.chroma3),
    bgHue: rotateHue(hue, PALETTE_CHORD.paperOffset),
    surfaceTint: Math.min(MAX_SURFACE_TINT, PALETTE_CHORD.surfaceTint * b),
  };
}

/** Wheel stop whose primary hue sits closest to the given hue. */
export function nearestWheelStop(primaryHue: number) {
  return Math.round(rotateHue(primaryHue, -DEFAULT_ACCENT_HUE) / WHEEL_STEP) % WHEEL_STOP_COUNT;
}

/** Recover the brilliance axis from the applied primary chroma. */
export function brillianceFromChroma(chroma: number) {
  return clampBrilliance(chroma / DEFAULT_ACCENT_CHROMA);
}

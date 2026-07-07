/* Curated theme palettes. Each preset is a two-accent editorial pairing plus a
 * paper tint — like a two-color print job, not a hue-rotation. The CSS in
 * app/globals.css derives the whole accent family from these seeds in OKLCH
 * (light: L 0.45 text-safe; dark: L 0.73 with chroma * 0.78), so a pair only
 * needs its hue + chroma here.
 *
 * Pair table — every pairing was judged against the preset's background tint
 * in light AND dark and validated at >= 4.5:1 contrast for text usage
 * (see tests/palette-presets.test.ts, which recomputes the derivations):
 *
 * | Preset | Accent 1 (hue/chroma)  | Accent 2 (hue/chroma)   | Pairing logic                          |
 * |--------|------------------------|-------------------------|----------------------------------------|
 * | Forest | forest green 156/0.09  | terracotta 45/0.11      | classic field-guide green + clay       |
 * | Ocean  | deep blue 235/0.11     | marigold 70/0.12        | indigo + amber, print's oldest duo     |
 * | Iris   | violet 290/0.11        | olive citron 110/0.10   | Penguin-cover violet + moss            |
 * | Rose   | warm red 15/0.11       | deep teal 195/0.09      | terracotta rose + teal, editorial      |
 * | Ember  | gold 60/0.10           | ink indigo 265/0.10     | amber + indigo, warm page cool voice   |
 * | Mono   | graphite 250/0.015     | muted rust 40/0.06      | black + red, restrained print accent   |
 */

export const DEFAULT_ACCENT_HUE = 156;
export const DEFAULT_ACCENT_CHROMA = 0.09;
// The default second accent reproduces Forest's terracotta pair; globals.css
// carries the same values as the --accent-2-hue/--accent-2-chroma defaults.
export const DEFAULT_ACCENT_2_HUE = 45;
export const DEFAULT_ACCENT_2_CHROMA = 0.11;

export type PalettePreset = {
  name: string;
  /** Primary accent seed (actions, emphasis, selection). */
  hue: number;
  chroma: number;
  /** Second accent seed (editorial header/line voice). */
  hue2: number;
  chroma2: number;
  /** Paper tint axis; null keeps the neutral canvas. */
  bgHue: number | null;
  surfaceTint: number;
};

export const PALETTE_PRESETS: PalettePreset[] = [
  {
    name: 'Forest',
    hue: DEFAULT_ACCENT_HUE,
    chroma: DEFAULT_ACCENT_CHROMA,
    hue2: DEFAULT_ACCENT_2_HUE,
    chroma2: DEFAULT_ACCENT_2_CHROMA,
    bgHue: 95,
    surfaceTint: 0.22,
  },
  { name: 'Ocean', hue: 235, chroma: 0.11, hue2: 70, chroma2: 0.12, bgHue: 215, surfaceTint: 0.28 },
  { name: 'Iris', hue: 290, chroma: 0.11, hue2: 110, chroma2: 0.1, bgHue: 310, surfaceTint: 0.2 },
  { name: 'Rose', hue: 15, chroma: 0.11, hue2: 195, chroma2: 0.09, bgHue: 35, surfaceTint: 0.24 },
  { name: 'Ember', hue: 60, chroma: 0.1, hue2: 265, chroma2: 0.1, bgHue: 80, surfaceTint: 0.3 },
  { name: 'Mono', hue: 250, chroma: 0.015, hue2: 40, chroma2: 0.06, bgHue: null, surfaceTint: 0 },
];

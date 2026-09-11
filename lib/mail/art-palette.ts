export interface Swatch {
  rgb: [number, number, number];
  share: number;
}

export function paletteFromPixels(pixels: Array<[number, number, number]>, k: number): Swatch[] {
  if (pixels.length === 0) return [];
  let centers = pixels.filter((_, i) => i % Math.max(1, Math.floor(pixels.length / k)) === 0).slice(0, k);
  while (centers.length < k) centers.push(pixels[centers.length % pixels.length]);
  let assignment = new Array(pixels.length).fill(0);
  for (let iteration = 0; iteration < 12; iteration += 1) {
    assignment = pixels.map((p) => {
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      centers.forEach((c, i) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      });
      return best;
    });
    const sums = centers.map(() => [0, 0, 0, 0]);
    pixels.forEach((p, i) => {
      const s = sums[assignment[i]];
      s[0] += p[0];
      s[1] += p[1];
      s[2] += p[2];
      s[3] += 1;
    });
    centers = sums.map((s, i) =>
      s[3] ? ([s[0] / s[3], s[1] / s[3], s[2] / s[3]] as [number, number, number]) : centers[i],
    );
  }
  const counts = centers.map(() => 0);
  for (const a of assignment) counts[a] += 1;
  return centers
    .map((c, i) => ({ rgb: c.map(Math.round) as [number, number, number], share: counts[i] / pixels.length }))
    .filter((swatch) => swatch.share > 0)
    .sort((a, b) => b.share - a.share);
}

/** The accent is the most saturated colour the painting can spare: high
 *  chroma, not too dark, weighted a little by how much of the canvas it
 *  covers. Monochrome paintings retain their neutral ink. */
export function pickAccent(palette: Swatch[]): { hue: number; chroma: number } {
  let best: { hue: number; chroma: number; score: number } | null = null;
  for (const swatch of palette) {
    const { l, c, h } = oklch(swatch.rgb);
    if (l < 0.18 || l > 0.95) continue;
    const score = c * (0.7 + swatch.share);
    if (!best || score > best.score) best = { hue: h, chroma: c, score };
  }
  if (!best || best.chroma < 0.045) return { hue: best?.hue ?? 0, chroma: best?.chroma ?? 0 };
  return { hue: best.hue, chroma: Math.min(best.chroma, 0.19) };
}

export function hex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

function oklch([r8, g8, b8]: [number, number, number]): { l: number; c: number; h: number } {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = lin(r8);
  const g = lin(g8);
  const b = lin(b8);
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.sqrt(a * a + bb * bb);
  let h = (Math.atan2(bb, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

/** Pale ink from an actual image swatch. It remains readable over the 60%
 * black scrim even in the darkest (6%) flecks of the printed texture. */
export function artInkColor(palette: readonly string[] = []): string {
  const swatches = palette.filter((color) => /^#[a-f0-9]{6}$/i.test(color));
  let best = swatches[0] ?? '#e8e4dc';
  let score = -1;
  swatches.forEach((color, index) => {
    const rgb = fromHex(color);
    const { l, c } = oklch(rgb);
    if (l < 0.18 || l > 0.95) return;
    const value = c * (1 + 1 / (index + 1));
    if (value > score) {
      best = color;
      score = value;
    }
  });
  const rgb = fromHex(best);
  for (let white = 0.5; white <= 1.001; white += 0.01) {
    const ink = rgb.map((v) => Math.round(v + (255 - v) * white)) as [number, number, number];
    const textured = ink.map((v) => Math.floor(v * 0.94)) as [number, number, number];
    if (contrastRatio(hex(textured), '#666666') >= 4.5) return hex(ink);
  }
  return '#ffffff';
}

function fromHex(color: string): [number, number, number] {
  return [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16)) as [number, number, number];
}

export function contrastRatio(a: string, b: string): number {
  const luminance = (color: string) => {
    const rgb = fromHex(color).map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

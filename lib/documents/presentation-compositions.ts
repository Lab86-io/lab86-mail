import { contrastRatio, estimateTextLines, textFits } from './deck-quality';
import type { DeckElementV2, DeckModelV2, DeckSlideV2, DeckTheme } from './model';

/**
 * The slide compositions of the presentation design system, composed
 * deterministically from content. Geometry, type scale and spacing copy the
 * reference deck in `deck-fixtures.ts` number for number; a test keeps the two
 * within half a percent. Long copy steps the type down by rule, never past
 * the readable floor. Nothing here calls a model.
 */

export const COMPOSITION_ROLES = [
  'cover',
  'statement',
  'image-left',
  'image-right',
  'metrics',
  'chart',
  'table',
  'process',
  'comparison',
  'list',
  'quote',
  'close',
] as const;
export type CompositionRole = (typeof COMPOSITION_ROLES)[number];

export const PALETTE_NAMES = ['editorial', 'signal'] as const;
export type PaletteName = (typeof PALETTE_NAMES)[number];
export const FONT_PAIR_NAMES = ['serif', 'sans'] as const;
export type FontPairName = (typeof FONT_PAIR_NAMES)[number];

export type DeckColors = DeckTheme['colors'];
export type PaletteInput = PaletteName | DeckColors;

/** The two named palettes. These equal `DECK_THEMES` in the fixtures; a test guards the match. */
export const DECK_PALETTES: Record<PaletteName, DeckColors> = {
  editorial: {
    background: '#F4F1EA',
    surface: '#E7E1D3',
    ink: '#1E2A38',
    muted: '#5E5A51',
    accent: '#AE4B2B',
    accentInk: '#FFFFFF',
  },
  signal: {
    background: '#F7F7F4',
    surface: '#E4E6E9',
    ink: '#0B0F14',
    muted: '#5B6470',
    accent: '#2F5BFF',
    accentInk: '#FFFFFF',
  },
};

export const DECK_FONT_PAIRS: Record<FontPairName, DeckTheme['fonts']> = {
  serif: {
    display: { family: 'Fraunces', exportFamily: 'Georgia', fallback: 'serif' },
    body: { family: 'Geist', exportFamily: 'Aptos', fallback: 'sans-serif' },
    mono: { family: 'Geist Mono', exportFamily: 'Consolas', fallback: 'monospace' },
  },
  sans: {
    display: { family: 'Geist', exportFamily: 'Aptos', fallback: 'sans-serif' },
    body: { family: 'Geist', exportFamily: 'Aptos', fallback: 'sans-serif' },
    mono: { family: 'Geist Mono', exportFamily: 'Consolas', fallback: 'monospace' },
  },
};

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

/**
 * A stored theme may carry a color that is not six-digit hex (the schema
 * accepts any short string). Every slot that is not hex takes the Editorial
 * value, so mixing and contrast never see NaN channels.
 */
export function safeDeckColors(colors: Partial<DeckColors> | undefined): DeckColors {
  const fallback = DECK_PALETTES.editorial;
  const next = { ...fallback };
  for (const key of Object.keys(fallback) as (keyof DeckColors)[]) {
    const value = colors?.[key];
    if (isHexColor(value)) next[key] = value;
  }
  return next;
}

function hexToRgb(value: string): [number, number, number] {
  const hex = value.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function rgbToHex(rgb: [number, number, number]) {
  return `#${rgb
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`.toUpperCase();
}

/** Linear mix of two hex colors; `t` is the share of `b`. A value that is not hex takes the Editorial ink. */
export function mixHex(a: string, b: string, t: number) {
  const left = hexToRgb(isHexColor(a) ? a : DECK_PALETTES.editorial.ink);
  const right = hexToRgb(isHexColor(b) ? b : DECK_PALETTES.editorial.ink);
  return rgbToHex([0, 1, 2].map((i) => left[i] + (right[i] - left[i]) * t) as [number, number, number]);
}

function sameColor(a: string | undefined, b: string | undefined) {
  return Boolean(a && b) && String(a).toUpperCase() === String(b).toUpperCase();
}

function paletteName(colors: DeckColors): PaletteName | null {
  for (const name of PALETTE_NAMES) {
    const named = DECK_PALETTES[name];
    if ((Object.keys(named) as (keyof DeckColors)[]).every((key) => sameColor(named[key], colors[key])))
      return name;
  }
  return null;
}

/**
 * Colors the compositions derive from a palette: the soft hairline, and the
 * text and rule colors used on ink and accent grounds. The named palettes keep
 * the hand-picked values of the reference deck; custom palettes are mixed.
 */
export interface PaletteTokens extends DeckColors {
  soft: string;
  onInkBody: string;
  onInkRule: string;
  onAccentBody: string;
}

export function paletteTokens(input: DeckColors): PaletteTokens {
  const colors = safeDeckColors(input);
  const name = paletteName(colors);
  if (name === 'editorial')
    return {
      ...colors,
      soft: '#C9C1AE',
      onInkBody: '#C9C1AE',
      onInkRule: '#3A4656',
      onAccentBody: '#F1DDD5',
    };
  if (name === 'signal')
    return {
      ...colors,
      soft: '#9AA3AE',
      onInkBody: '#B6BEC9',
      onInkRule: '#2A3140',
      onAccentBody: '#EEF2FF',
    };
  return {
    ...colors,
    soft: mixHex(colors.surface, colors.muted, 0.4),
    onInkBody: mixHex(colors.background, colors.ink, 0.25),
    onInkRule: mixHex(colors.ink, colors.background, 0.15),
    onAccentBody: mixHex(colors.accentInk, colors.accent, 0.15),
  };
}

export interface ResolvedPalette {
  colors: DeckColors;
  name: PaletteName | 'custom';
  /** True when a custom palette failed the contrast floor and Editorial was used instead. */
  adjusted: boolean;
}

/** A palette by name, or a custom six-color set when it clears the contrast floors. */
export function resolvePalette(input: PaletteInput): ResolvedPalette {
  if (typeof input === 'string') return { colors: DECK_PALETTES[input], name: input, adjusted: false };
  const valid = (Object.keys(DECK_PALETTES.editorial) as (keyof DeckColors)[]).every((key) =>
    isHexColor(input[key]),
  );
  const inkOnPaper = valid ? contrastRatio(input.ink, input.background) : null;
  const accentOnPaper = valid ? contrastRatio(input.accent, input.background) : null;
  const inkOnAccent = valid ? contrastRatio(input.accentInk, input.accent) : null;
  const paperOnInk = valid ? contrastRatio(input.background, input.ink) : null;
  const mutedOnPaper = valid ? contrastRatio(input.muted, input.background) : null;
  const ok =
    (inkOnPaper ?? 0) >= 4.5 &&
    (accentOnPaper ?? 0) >= 3 &&
    (inkOnAccent ?? 0) >= 3 &&
    (paperOnInk ?? 0) >= 4.5 &&
    (mutedOnPaper ?? 0) >= 4.5;
  if (!ok) return { colors: DECK_PALETTES.editorial, name: 'editorial', adjusted: true };
  const named = paletteName(input);
  return { colors: { ...input }, name: named ?? 'custom', adjusted: false };
}

export function buildDeckTheme(palette: PaletteInput, fontPair: FontPairName): DeckTheme {
  const resolved = resolvePalette(palette);
  const name = resolved.name === 'custom' ? 'Custom' : resolved.name === 'signal' ? 'Signal' : 'Editorial';
  return { name, colors: { ...resolved.colors }, fonts: structuredClone(DECK_FONT_PAIRS[fontPair]) };
}

/** The font pair a theme uses, by its display family. */
export function fontPairOf(theme: DeckTheme): FontPairName {
  return theme.fonts.display.family === 'Fraunces' ? 'serif' : 'sans';
}

export interface CompositionItem {
  label: string;
  detail: string;
  /** A short third line: a date, an owner, a unit. Shown where the composition has a slot for it. */
  meta?: string;
}

export interface CompositionChart {
  type: 'column' | 'bar' | 'line' | 'pie' | 'doughnut';
  categories: string[];
  series: { name: string; values: number[] }[];
  unit?: string;
  source?: string;
}

/** An owned image the deck may show. Never an external link. */
export interface CompositionAsset {
  assetId: string;
  src: string;
  alt?: string;
  aspect?: number;
  source?: string;
  focal?: { x: number; y: number };
}

export interface CompositionImage {
  alt: string;
  asset?: CompositionAsset;
}

/**
 * A public-domain painting placed by the composition, always with a credit.
 * `credit` is the visible line: "Title, Artist, Date, Museum". The image
 * element's `source` and a notes line carry the same text behind the
 * `ARTWORK_PREFIX`, so a later restyle can tell artwork from the user's images.
 */
export interface CompositionArtwork {
  asset: CompositionAsset;
  credit: string;
}

export const ARTWORK_PREFIX = 'Artwork: ';

export function artworkSourceLine(artwork: CompositionArtwork) {
  return `${ARTWORK_PREFIX}${artwork.credit}`;
}

export function isArtworkSource(source: string | undefined): boolean {
  return Boolean(source?.startsWith(ARTWORK_PREFIX));
}

/** Notes without the composer's artwork lines. */
export function stripArtworkNotes(notes: string | undefined): string {
  return (notes ?? '')
    .split('\n')
    .filter((line) => !line.startsWith(ARTWORK_PREFIX))
    .join('\n')
    .trim();
}

/** Notes with the artwork line appended once. */
export function withArtworkNote(notes: string | undefined, artwork: CompositionArtwork | undefined) {
  const base = stripArtworkNotes(notes);
  if (!artwork) return base;
  return base ? `${base}\n${artworkSourceLine(artwork)}` : artworkSourceLine(artwork);
}

/** Everything one slide says. The composition decides where it goes. */
export interface CompositionContent {
  role: CompositionRole;
  title: string;
  kicker?: string;
  body?: string;
  items: CompositionItem[];
  notes?: string;
  chart?: CompositionChart;
  table?: { headers: string[]; rows: string[][]; source?: string | null };
  image?: CompositionImage;
  /** Cover foot line, e.g. who the deck is for. */
  footer?: string;
  /** The visible source caption under a chart; defaults to the chart's own source. */
  sourceLine?: string;
  /** A credited painting for the compositions that hang one; ignored where an owned image already sits. */
  artwork?: CompositionArtwork;
}

export interface ComposeSlideOptions {
  theme: DeckTheme;
  index: number;
  total: number;
  slideId: string;
  /** Existing element ids by slot, reused when content maps one to one. */
  ids?: Partial<Record<string, string>>;
}

type Text = Extract<DeckElementV2, { type: 'text' }>;
type TextProps = Partial<Omit<Text, 'id' | 'type' | 'text' | 'x' | 'y' | 'width' | 'height'>>;
type Box = [number, number, number, number];

const SLIDE_WIDTH_PT = 960;
const SLIDE_HEIGHT_PT = 540;

/** Name carried on every composed element: `role/slot`. Restyle reads it back. */
export function elementSlotName(role: CompositionRole, slot: string) {
  return `${role}/${slot}`;
}

export function parseSlotName(name: string | undefined): { role: CompositionRole; slot: string } | null {
  if (!name) return null;
  const at = name.indexOf('/');
  if (at < 0) return null;
  const role = name.slice(0, at) as CompositionRole;
  if (!COMPOSITION_ROLES.includes(role)) return null;
  return { role, slot: name.slice(at + 1) };
}

/** Largest size from `max` down to `min`, in steps of `step`, at which the copy fits its box. */
export function fitTypeSize(
  text: string,
  box: Box,
  max: number,
  min: number,
  props: Pick<TextProps, 'role' | 'font' | 'lineHeight' | 'letterSpacing'>,
  step = 2,
) {
  let size = max;
  while (size > min) {
    const probe: Text = {
      id: 'probe',
      type: 'text',
      text,
      x: box[0],
      y: box[1],
      width: box[2],
      height: box[3],
      fontSize: size,
      ...props,
    };
    if (textFits(probe)) return size;
    size = Math.max(min, size - step);
  }
  return min;
}

class Slide {
  readonly elements: DeckElementV2[] = [];
  private readonly used = new Set<string>();
  constructor(
    private readonly role: CompositionRole,
    private readonly options: ComposeSlideOptions,
  ) {}

  id(slot: string) {
    const preferred = this.options.ids?.[slot];
    const candidate = preferred && !this.used.has(preferred) ? preferred : `${this.options.slideId}-${slot}`;
    let unique = candidate;
    let n = 2;
    while (this.used.has(unique)) unique = `${candidate}-${n++}`;
    this.used.add(unique);
    return unique;
  }

  text(slot: string, value: string, box: Box, props: TextProps = {}) {
    if (!value.trim()) return;
    this.elements.push({
      id: this.id(slot),
      type: 'text',
      name: elementSlotName(this.role, slot),
      text: value,
      x: box[0],
      y: box[1],
      width: box[2],
      height: box[3],
      ...props,
    });
  }

  /** Reflow generated captions into reserved space before requesting copy edits. */
  caption(slot: string, value: string, box: Box, maxHeight: number, props: TextProps) {
    const text = value.replace(/\s+/g, ' ').trim();
    const probe: Text = {
      id: 'caption',
      type: 'text',
      text,
      x: box[0],
      y: box[1],
      width: box[2],
      height: box[3],
      ...props,
    };
    const needed = ((estimateTextLines(probe) * (props.fontSize ?? 11) * 1.3) / SLIDE_HEIGHT_PT) * 100;
    const height = Math.min(maxHeight, Math.max(box[3], needed));
    const y = props.valign === 'bottom' ? box[1] + box[3] - height : Math.min(box[1], 97 - height);
    this.text(slot, text, [box[0], y, box[2], height], props);
  }

  rule(slot: string, x: number, y: number, width: number, color: string, weight = 1.25) {
    this.elements.push({
      id: this.id(slot),
      type: 'line',
      name: elementSlotName(this.role, slot),
      x,
      y,
      width,
      height: 0,
      stroke: { color, width: weight },
    });
  }

  upright(slot: string, x: number, y: number, height: number, color: string, weight = 1.25) {
    this.elements.push({
      id: this.id(slot),
      type: 'line',
      name: elementSlotName(this.role, slot),
      x,
      y,
      width: 0,
      height,
      stroke: { color, width: weight },
    });
  }

  dot(slot: string, cx: number, cy: number, diameterPt: number, fill: string, stroke?: string) {
    const w = (diameterPt / SLIDE_WIDTH_PT) * 100;
    const h = (diameterPt / SLIDE_HEIGHT_PT) * 100;
    this.elements.push({
      id: this.id(slot),
      type: 'shape',
      name: elementSlotName(this.role, slot),
      shape: 'ellipse',
      x: cx - w / 2,
      y: cy - h / 2,
      width: w,
      height: h,
      fill,
      ...(stroke ? { stroke: { color: stroke, width: 1.5 } } : {}),
    });
  }

  rect(slot: string, box: Box, fill: string, extra: { shape?: 'rect' | 'roundRect'; radius?: number } = {}) {
    this.elements.push({
      id: this.id(slot),
      type: 'shape',
      name: elementSlotName(this.role, slot),
      shape: extra.shape ?? 'rect',
      x: box[0],
      y: box[1],
      width: box[2],
      height: box[3],
      fill,
      ...(extra.radius !== undefined ? { radius: extra.radius } : {}),
    });
  }

  image(slot: string, image: CompositionImage, box: Box, focal: { x: number; y: number }) {
    const asset = image.asset;
    if (!asset) return false;
    this.elements.push({
      id: this.id(slot),
      type: 'image',
      name: elementSlotName(this.role, slot),
      x: box[0],
      y: box[1],
      width: box[2],
      height: box[3],
      assetId: asset.assetId,
      src: asset.src,
      alt: image.alt || asset.alt || '',
      fit: 'cover',
      focal: asset.focal ?? focal,
      ...(asset.aspect ? { aspect: asset.aspect } : {}),
      ...(asset.source ? { source: asset.source } : {}),
    });
    return true;
  }

  /** A painting in its box, carrying the credit as its source. */
  artwork(slot: string, artwork: CompositionArtwork, box: Box, focal: { x: number; y: number }) {
    this.elements.push({
      id: this.id(slot),
      type: 'image',
      name: elementSlotName(this.role, slot),
      x: box[0],
      y: box[1],
      width: box[2],
      height: box[3],
      assetId: artwork.asset.assetId,
      src: artwork.asset.src,
      alt: artwork.asset.alt || artwork.credit,
      fit: 'cover',
      focal: artwork.asset.focal ?? focal,
      ...(artwork.asset.aspect ? { aspect: artwork.asset.aspect } : {}),
      source: artworkSourceLine(artwork),
    });
  }

  /** The visible credit: 11 pt, muted, where a caption fits. */
  credit(artwork: CompositionArtwork, box: Box, color: string, align: 'left' | 'right' = 'left') {
    this.text('credit', artwork.credit, box, {
      role: 'caption',
      fontSize: 11,
      color,
      align,
      valign: 'bottom',
    });
  }

  chart(slot: string, chart: CompositionChart, box: Box, colors: string[]) {
    const round = chart.type === 'pie' || chart.type === 'doughnut';
    this.elements.push({
      id: this.id(slot),
      type: 'chart',
      name: elementSlotName(this.role, slot),
      chart: chart.type,
      x: box[0],
      y: box[1],
      width: box[2],
      height: box[3],
      categories: chart.categories,
      series: chart.series,
      colors: round
        ? colors.slice(0, Math.max(1, chart.categories.length))
        : colors.slice(0, chart.series.length),
      values: !round && chart.series.length === 1 && chart.categories.length <= 8,
      legend: round || chart.series.length > 1,
      ...(chart.unit ? { unit: chart.unit } : {}),
      ...(chart.source ? { source: chart.source } : {}),
    });
  }
}

interface Voice {
  c: PaletteTokens;
  editorial: boolean;
  display: TextProps;
  kicker: TextProps;
  paper: string;
}

function voice(theme: DeckTheme): Voice {
  const editorial = fontPairOf(theme) === 'serif';
  const c = paletteTokens(theme.colors);
  return {
    c,
    editorial,
    display: editorial ? { fontWeight: 500 } : { fontWeight: 700, letterSpacing: -0.03 },
    kicker: { fontWeight: editorial ? 500 : 600, letterSpacing: editorial ? 0.04 : 0 },
    paper: c.background,
  };
}

/** The painting a composition may hang: only when no owned image takes the slot. */
function artworkFor(content: CompositionContent): CompositionArtwork | undefined {
  if (content.image?.asset) return undefined;
  return content.artwork;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Column pitch and width for `count` items across the 88 percent content width. */
function columns(count: number): { pitch: number; width: number } {
  if (count <= 1) return { pitch: 88, width: 88 };
  if (count === 2) return { pitch: 44, width: 40 };
  if (count === 3) return { pitch: 30, width: 26 };
  return { pitch: 22.4, width: 20 };
}

/** Facts row pitch and width inside a 42 percent text column. */
function factColumns(count: number): { pitch: number; width: number } {
  if (count <= 1) return { pitch: 42, width: 42 };
  if (count === 2) return { pitch: 21, width: 19 };
  if (count === 3) return { pitch: 15, width: 13 };
  return { pitch: 10.5, width: 9.5 };
}

function pageNumber(s: Slide, options: ComposeSlideOptions, color: string, x = 86) {
  s.text('page', pad(options.index + 1), [x, 90, 8, 4], {
    role: 'caption',
    fontSize: 11,
    color,
    align: 'right',
    valign: 'bottom',
    font: 'mono',
  });
}

function kickerLine(s: Slide, v: Voice, kicker: string | undefined, box: Box, color = v.c.accent) {
  if (kicker) s.text('kicker', kicker, box, { role: 'kicker', fontSize: 12, color, ...v.kicker });
}

function sectionTitle(s: Slide, v: Voice, title: string, box: Box, max: number, color?: string) {
  const size = fitTypeSize(title, box, max, 28, { role: 'title', lineHeight: 1.04 });
  s.text('title', title, box, {
    role: 'title',
    fontSize: size,
    lineHeight: size >= 34 ? 1.04 : 1.06,
    valign: 'top',
    ...(color ? { color } : {}),
    ...v.display,
  });
}

function factsRow(s: Slide, v: Voice, items: CompositionItem[], x0: number, width: number, y: number) {
  const layout = width > 60 ? columns(items.length) : factColumns(items.length);
  items.slice(0, 4).forEach((item, i) => {
    const x = x0 + i * layout.pitch;
    const size = fitTypeSize(item.label, [x, y, layout.width, 8], 24, 16, { role: 'number', lineHeight: 1 });
    s.text(`item-${i}-label`, item.label, [x, y, layout.width, 8], {
      role: 'number',
      fontSize: size,
      ...v.display,
      color: v.c.ink,
    });
    s.text(`item-${i}-detail`, item.detail, [x, y + 8, layout.width, 5], {
      role: 'caption',
      fontSize: 11,
      color: v.c.muted,
      valign: 'top',
    });
  });
}

function composeCover(content: CompositionContent, options: ComposeSlideOptions): DeckSlideV2 {
  const v = voice(options.theme);
  const s = new Slide('cover', options);
  const artwork = artworkFor(content);
  let hasImage = content.image
    ? s.image('image', content.image, [52, 0, 48, 100], { x: 0.5, y: 0.55 })
    : false;
  if (!hasImage && artwork) {
    // Artwork variant: the painting takes the right half; the credit sits under the foot line.
    s.artwork('image', artwork, [52, 0, 48, 100], { x: 0.5, y: 0.4 });
    hasImage = true;
  }
  if (!hasImage) s.rect('panel', [72, 0, 28, 100], v.editorial ? v.c.ink : v.c.accent);
  if (v.editorial) s.rule('rule', 6, 9, 5, v.c.accent, 1.5);
  else s.rect('chip', [6, 10.5, 1.2, 5], v.c.accent);
  kickerLine(s, v, content.kicker, [v.editorial ? 6 : 9, 11, 40, 4.5], v.editorial ? v.c.accent : v.c.ink);
  const titleBox: Box = hasImage ? [6, 24, 42, 40] : [6, 24, 60, 40];
  const max = v.editorial ? 68 : 62;
  const size = fitTypeSize(content.title, titleBox, max, 46, { role: 'title', lineHeight: 0.96 });
  s.text('title', content.title, titleBox, {
    role: 'title',
    fontSize: size,
    lineHeight: 0.96,
    valign: 'top',
    ...v.display,
  });
  if (content.body)
    s.text('body', content.body, hasImage ? [6, 66, 38, 12] : [6, 66, 50, 12], {
      role: 'subtitle',
      fontSize: 17,
      color: v.c.muted,
      lineHeight: 1.35,
      valign: 'top',
    });
  const foot = content.footer || content.items[0]?.label;
  if (foot)
    s.caption('foot', foot, [6, artwork ? 86 : 90, 40, 4], 12, {
      role: 'caption',
      fontSize: 11,
      color: v.c.muted,
      valign: 'bottom',
    });
  if (artwork) s.credit(artwork, [6, 90.5, 44, 6], v.c.muted);
  return { id: options.slideId, title: content.title, elements: s.elements, ...notes(content, artwork) };
}

function composeStatement(content: CompositionContent, options: ComposeSlideOptions): DeckSlideV2 {
  const v = voice(options.theme);
  const s = new Slide('statement', options);
  const artwork = artworkFor(content);
  // Painting behind the statement: the painting sits under an ink veil, so the ground stays ink.
  // A palette whose accent cannot carry body copy also falls back to the ink ground.
  const accentCarries =
    (contrastRatio(v.c.onAccentBody, v.c.accent) ?? 0) >= 4.5 &&
    (contrastRatio(v.c.accentInk, v.c.accent) ?? 0) >= 3;
  const onInk = v.editorial || Boolean(artwork) || !accentCarries;
  const ground = onInk ? v.c.ink : v.c.accent;
  const text = onInk ? v.paper : v.c.accentInk;
  const soft = onInk ? v.c.onInkBody : v.c.onAccentBody;
  if (artwork) {
    s.elements.push({
      id: s.id('veil'),
      type: 'shape',
      name: elementSlotName('statement', 'veil'),
      shape: 'rect',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fill: v.c.ink,
      opacity: 0.35,
    });
  }
  if (v.editorial) s.rule('rule', 8, 17, 5, v.c.accent, 1.5);
  const kickerColor = soft;
  kickerLine(s, v, content.kicker, [8, 11, 60, 4.5], kickerColor);
  const size = fitTypeSize(content.title, [8, 22, 76, 46], v.editorial ? 56 : 58, 40, {
    role: 'title',
    lineHeight: 1.02,
  });
  s.text('title', content.title, [8, 22, 76, 46], {
    role: 'title',
    fontSize: size,
    lineHeight: 1.02,
    color: text,
    valign: 'top',
    ...v.display,
  });
  if (content.body)
    s.text('body', content.body, [8, 74, 56, 14], {
      role: 'body',
      fontSize: 16,
      color: soft,
      lineHeight: 1.4,
      valign: 'top',
    });
  if (artwork) s.credit(artwork, [8, 88, 60, 6], soft);
  pageNumber(s, options, soft);
  return {
    id: options.slideId,
    title: content.title,
    elements: s.elements,
    background: ground,
    ...(artwork
      ? {
          backgroundImage: {
            assetId: artwork.asset.assetId,
            src: artwork.asset.src,
            opacity: 0.28,
            focal: artwork.asset.focal ?? { x: 0.5, y: 0.4 },
          },
        }
      : {}),
    ...notes(content, artwork),
  };
}

function composeImageSide(
  content: CompositionContent,
  options: ComposeSlideOptions,
  side: 'left' | 'right',
): DeckSlideV2 {
  const v = voice(options.theme);
  const role = side === 'left' ? 'image-left' : 'image-right';
  const s = new Slide(role, options);
  const imageBox: Box = side === 'left' ? [0, 0, 46, 100] : [54, 0, 46, 100];
  const artwork = artworkFor(content);
  let hasImage = content.image ? s.image('image', content.image, imageBox, { x: 0.45, y: 0.5 }) : false;
  if (!hasImage && artwork) {
    s.artwork('image', artwork, imageBox, { x: 0.5, y: 0.4 });
    hasImage = true;
  }
  const x = hasImage && side === 'left' ? 52 : 6;
  if (hasImage) {
    kickerLine(s, v, content.kicker, [x, 12, 40, 4.5]);
    sectionTitle(s, v, content.title, [x, 18, 42, 24], 38);
    if (content.body)
      s.text('body', content.body, [x, 44, 40, 24], {
        role: 'body',
        fontSize: 15,
        lineHeight: 1.5,
        valign: 'top',
      });
    if (content.items.length) {
      if (v.editorial) s.rule('rule', x, 72, 42, v.c.soft, 1);
      factsRow(s, v, content.items, x, 42, 75);
    }
    if (artwork) s.credit(artwork, [x, 89, 33, 6], v.c.muted);
  } else if (side === 'left') {
    // Typographic variant: the text takes the full measure and the facts spread across it.
    kickerLine(s, v, content.kicker, [6, 12, 40, 4.5]);
    sectionTitle(s, v, content.title, [6, 18, 56, 24], 38);
    if (content.body)
      s.text('body', content.body, [6, 44, 52, 24], {
        role: 'body',
        fontSize: 15,
        lineHeight: 1.5,
        valign: 'top',
      });
    if (content.items.length) {
      if (v.editorial) s.rule('rule', 6, 72, 88, v.c.soft, 1);
      factsRow(s, v, content.items, 6, 88, 75);
    }
  } else {
    // Typographic variant: a surface column on the right carries the items.
    kickerLine(s, v, content.kicker, [6, 12, 40, 4.5]);
    sectionTitle(s, v, content.title, [6, 18, 50, 24], 38);
    if (content.body)
      s.text('body', content.body, [6, 44, 46, 30], {
        role: 'body',
        fontSize: 15,
        lineHeight: 1.5,
        valign: 'top',
      });
    if (content.items.length) {
      s.rect('panel', [62, 12, 32, 76], v.c.surface);
      content.items.slice(0, 4).forEach((item, i) => {
        const y = 16 + i * 18;
        s.text(`item-${i}-label`, item.label, [65, y, 26, 6], {
          role: 'subtitle',
          fontSize: 16,
          valign: 'top',
          ...v.display,
        });
        s.text(`item-${i}-detail`, item.detail, [65, y + 6, 26, 10], {
          role: 'body',
          fontSize: 12,
          lineHeight: 1.4,
          color: v.c.muted,
          valign: 'top',
        });
      });
    }
  }
  // A right-hand image owns the corner, so the page number moves into the text column.
  pageNumber(s, options, v.c.muted, hasImage && side === 'right' ? 40 : 86);
  return { id: options.slideId, title: content.title, elements: s.elements, ...notes(content, artwork) };
}

function chartColors(v: Voice) {
  return [v.c.accent, v.c.ink, v.c.muted, v.c.soft];
}

function composeMetrics(content: CompositionContent, options: ComposeSlideOptions): DeckSlideV2 {
  const v = voice(options.theme);
  const s = new Slide('metrics', options);
  kickerLine(s, v, content.kicker, [6, 10, 40, 4.5]);
  const items = content.items.slice(0, 4);
  if (content.chart) {
    sectionTitle(s, v, content.title, [6, 16, 52, content.body ? 13 : 18], 34);
    if (content.body)
      s.text('body', content.body, [40, 30, 44, 7], {
        role: 'body',
        fontSize: 13,
        color: v.c.muted,
        valign: 'top',
      });
    const stacked =
      items.length <= 3
        ? { y0: 40, pitch: 20, h: 12, size: v.editorial ? 52 : 56 }
        : { y0: 38, pitch: 15, h: 9, size: 40 };
    items.forEach((item, i) => {
      const y = stacked.y0 + i * stacked.pitch;
      const size = fitTypeSize(item.label, [6, y, 26, stacked.h], stacked.size, 28, {
        role: 'number',
        lineHeight: 1,
      });
      s.text(`item-${i}-label`, item.label, [6, y, 26, stacked.h], {
        role: 'number',
        fontSize: size,
        ...(i === 0 ? { color: v.c.accent } : {}),
        ...v.display,
        valign: 'bottom',
      });
      s.text(`item-${i}-detail`, item.detail, [6, y + stacked.h, 26, 5], {
        role: 'caption',
        fontSize: 12,
        color: v.c.muted,
        valign: 'top',
      });
    });
    s.chart('chart', content.chart, [40, 38, 54, 50], chartColors(v));
    const sourceLine = content.sourceLine ?? content.chart.source;
    if (sourceLine)
      s.caption('source', sourceLine, [40, 90, 44, 5], 8, {
        role: 'caption',
        fontSize: 10.5,
        color: v.c.muted,
        valign: 'top',
      });
  } else {
    // Typographic variant: the numbers stand in a row under a hairline.
    sectionTitle(s, v, content.title, [6, 16, 60, 16], 34);
    if (content.body)
      s.text('body', content.body, [6, 32, 60, 7], {
        role: 'body',
        fontSize: 14,
        color: v.c.muted,
        valign: 'top',
      });
    if (items.length) {
      s.rule('rule', 6, 41, 88, v.c.ink, 1.25);
      const layout = columns(items.length);
      items.forEach((item, i) => {
        const x = 6 + i * layout.pitch;
        const size = fitTypeSize(item.label, [x, 45, layout.width, 14], 56, 28, {
          role: 'number',
          lineHeight: 1,
        });
        s.text(`item-${i}-label`, item.label, [x, 45, layout.width, 14], {
          role: 'number',
          fontSize: size,
          ...(i === 0 ? { color: v.c.accent } : {}),
          ...v.display,
          valign: 'bottom',
        });
        s.text(`item-${i}-detail`, item.detail, [x, 60, layout.width, 12], {
          role: 'body',
          fontSize: 13.5,
          lineHeight: 1.4,
          color: v.c.muted,
          valign: 'top',
        });
      });
    }
  }
  pageNumber(s, options, v.c.muted);
  return { id: options.slideId, title: content.title, elements: s.elements, ...notes(content) };
}

/** Editable table cells, using the same typography and rules as the deck. */
function composeTable(content: CompositionContent, options: ComposeSlideOptions): DeckSlideV2 {
  const v = voice(options.theme);
  const s = new Slide('table', options);
  kickerLine(s, v, content.kicker, [6, 7, 88, 4.5]);
  sectionTitle(s, v, content.title, [6, 14, 88, 14], 34);
  if (content.body)
    s.text('body', content.body, [6, 29, 88, 8], {
      role: 'body',
      fontSize: 14,
      color: v.c.muted,
      valign: 'top',
    });
  if (content.table) {
    const { headers, rows, source } = content.table;
    const width = 88 / headers.length;
    const rowHeight = Math.min(8, 48 / (rows.length + 1));
    headers.forEach((header, column) => {
      s.text(`table-header-${column}`, header, [6 + column * width, 39, width - 2, rowHeight - 1], {
        role: 'subtitle',
        fontSize: 12,
        fontWeight: 600,
        color: v.c.accent,
        align: column > 0 && rows.every((row) => /^[-+\d$€£]/.test(row[column])) ? 'right' : 'left',
        valign: 'middle',
      });
    });
    s.rule('table-header-rule', 6, 39 + rowHeight - 0.5, 88, v.c.ink);
    rows.forEach((row, index) => {
      const y = 39 + (index + 1) * rowHeight;
      row.forEach((cell, column) => {
        s.text(`table-cell-${index}-${column}`, cell, [6 + column * width, y, width - 2, rowHeight - 1], {
          role: 'body',
          fontSize: 12,
          color: v.c.ink,
          valign: 'middle',
          align: column > 0 && /^[-+\d$€£]/.test(cell) ? 'right' : 'left',
        });
      });
      s.rule(`table-rule-${index}`, 6, y + rowHeight - 0.5, 88, v.c.muted, 0.4);
    });
    if (source)
      s.caption('source', source, [6, 90, 76, 5], 7, { role: 'caption', fontSize: 10.5, color: v.c.muted });
  }
  pageNumber(s, options, v.c.muted);
  return { id: options.slideId, title: content.title, elements: s.elements, ...notes(content) };
}

function composeChart(content: CompositionContent, options: ComposeSlideOptions): DeckSlideV2 {
  if (!content.chart) return composeMetrics({ ...content, role: 'metrics' }, options);
  const v = voice(options.theme);
  const s = new Slide('chart', options);
  kickerLine(s, v, content.kicker, [6, 10, 40, 4.5]);
  sectionTitle(s, v, content.title, [6, 16, 40, 20], 34);
  if (content.body)
    s.text('body', content.body, [6, 38, 36, 20], {
      role: 'body',
      fontSize: 15,
      lineHeight: 1.5,
      color: v.c.muted,
      valign: 'top',
    });
  content.items.slice(0, 3).forEach((item, i) => {
    const y = 60 + i * 9;
    s.text(`item-${i}-label`, item.label, [6, y, 36, 4], {
      role: 'subtitle',
      fontSize: 14,
      valign: 'top',
      ...v.display,
    });
    s.text(`item-${i}-detail`, item.detail, [6, y + 4, 36, 4.5], {
      role: 'caption',
      fontSize: 11,
      color: v.c.muted,
      valign: 'top',
    });
  });
  s.chart('chart', content.chart, [46, 16, 48, 70], chartColors(v));
  const sourceLine = content.sourceLine ?? content.chart.source;
  if (sourceLine)
    s.caption('source', sourceLine, [46, 88, 38, 5], 9, {
      role: 'caption',
      fontSize: 10.5,
      color: v.c.muted,
      valign: 'top',
    });
  pageNumber(s, options, v.c.muted);
  return { id: options.slideId, title: content.title, elements: s.elements, ...notes(content) };
}

function composeProcess(content: CompositionContent, options: ComposeSlideOptions): DeckSlideV2 {
  const v = voice(options.theme);
  const s = new Slide('process', options);
  kickerLine(s, v, content.kicker, [6, 10, 40, 4.5]);
  sectionTitle(s, v, content.title, [6, 16, 60, 16], 34);
  const items = content.items.slice(0, 4);
  if (content.body && !items.length)
    s.text('body', content.body, [6, 34, 60, 20], {
      role: 'body',
      fontSize: 15,
      lineHeight: 1.5,
      valign: 'top',
    });
  if (items.length) {
    if (v.editorial) s.rule('line', 6, 56, 88, v.c.ink, 1.25);
    else s.rect('line', [6, 55, 88, 2], v.c.surface, { shape: 'roundRect', radius: 6 });
    const layout = columns(items.length);
    items.forEach((item, i) => {
      const x = 6 + i * layout.pitch;
      s.dot(
        `dot-${i}`,
        x + 1.5,
        56,
        v.editorial ? 14 : 18,
        v.editorial ? v.paper : v.c.accent,
        v.editorial ? v.c.ink : undefined,
      );
      s.text(`item-${i}-number`, pad(i + 1), [x, 36, layout.width, 5], {
        role: 'caption',
        fontSize: 11,
        color: v.c.accent,
        font: 'mono',
        valign: 'bottom',
      });
      const size = fitTypeSize(item.label, [x, 41, layout.width, 10], 22, 16, {
        role: 'subtitle',
        lineHeight: 1.1,
      });
      s.text(`item-${i}-label`, item.label, [x, 41, layout.width, 10], {
        role: 'subtitle',
        fontSize: size,
        valign: 'top',
        ...v.display,
      });
      if (item.meta)
        s.text(`item-${i}-meta`, item.meta, [x, 62, layout.width, 5], {
          role: 'caption',
          fontSize: 12,
          color: v.c.muted,
          valign: 'top',
        });
      s.text(
        `item-${i}-detail`,
        item.detail,
        item.meta ? [x, 67, layout.width - 0.5, 20] : [x, 62, layout.width - 0.5, 25],
        { role: 'body', fontSize: 13.5, lineHeight: 1.4, valign: 'top' },
      );
    });
  }
  pageNumber(s, options, v.c.muted);
  return { id: options.slideId, title: content.title, elements: s.elements, ...notes(content) };
}

function composeComparison(content: CompositionContent, options: ComposeSlideOptions): DeckSlideV2 {
  if (content.items.length < 2) return composeList({ ...content, role: 'list' }, options);
  const v = voice(options.theme);
  const s = new Slide('comparison', options);
  kickerLine(s, v, content.kicker, [6, 7, 40, 4.5]);
  sectionTitle(s, v, content.title, [6, 12, 70, content.body ? 10 : 12], 34);
  if (content.body)
    s.text('body', content.body, [6, 23, 70, 6], {
      role: 'body',
      fontSize: 13,
      color: v.c.muted,
      valign: 'top',
    });
  const items = content.items.slice(0, 4);
  const count = items.length;
  const gutter = 4;
  const width = (88 - (count - 1) * gutter) / count;
  items.forEach((item, i) => {
    const x = 6 + i * (width + gutter);
    const last = i === count - 1;
    s.rect(`panel-${i}`, [x, 30, width, 58], last ? v.c.accent : v.c.surface, {
      shape: v.editorial ? 'rect' : 'roundRect',
      radius: 10,
    });
    const ink = last ? v.c.accentInk : v.c.ink;
    const soft = last ? v.c.onAccentBody : v.c.muted;
    if (item.meta) {
      // Heading, figure, body: the reference comparison panel.
      s.text(`item-${i}-label`, item.label, [x + 3, 34, width - 6, 6], {
        role: 'subtitle',
        fontSize: 14,
        color: soft,
        valign: 'top',
      });
      const figure = fitTypeSize(item.meta, [x + 3, 41, width - 6, 8], 24, 16, {
        role: 'subtitle',
        lineHeight: 1.1,
      });
      s.text(`item-${i}-meta`, item.meta, [x + 3, 41, width - 6, 8], {
        role: 'subtitle',
        fontSize: figure,
        color: ink,
        valign: 'top',
        ...v.display,
      });
    } else {
      const size = fitTypeSize(item.label, [x + 3, 34, width - 6, 12], count === 4 ? 18 : 24, 16, {
        role: 'subtitle',
        lineHeight: 1.1,
      });
      s.text(`item-${i}-label`, item.label, [x + 3, 34, width - 6, 12], {
        role: 'subtitle',
        fontSize: size,
        color: ink,
        valign: 'top',
        ...v.display,
      });
    }
    s.text(`item-${i}-detail`, item.detail, [x + 3, item.meta ? 52 : 48, width - 6, item.meta ? 32 : 36], {
      role: 'body',
      fontSize: 14,
      lineHeight: 1.45,
      color: ink,
      valign: 'top',
    });
  });
  pageNumber(s, options, v.c.muted);
  return { id: options.slideId, title: content.title, elements: s.elements, ...notes(content) };
}

function composeList(content: CompositionContent, options: ComposeSlideOptions): DeckSlideV2 {
  const v = voice(options.theme);
  const s = new Slide('list', options);
  kickerLine(s, v, content.kicker, [6, 10, 40, 4.5]);
  sectionTitle(s, v, content.title, [6, 16, 60, 14], 34);
  if (content.body)
    s.text('body', content.body, [6, 30, 88, 9], {
      role: 'body',
      fontSize: 14,
      color: v.c.muted,
      valign: 'top',
    });
  const items = content.items.slice(0, 4);
  const pitch = 12;
  items.forEach((item, i) => {
    const y = 40 + i * pitch;
    s.rule(`rule-${i}`, 6, y, 88, v.c.soft, 1);
    s.text(`item-${i}-number`, pad(i + 1), [6, y + 1.5, 5, 5], {
      role: 'caption',
      fontSize: 11,
      color: v.c.accent,
      font: 'mono',
      valign: 'top',
    });
    const size = fitTypeSize(item.label, [12, y + 1, 40, 11], 20, 14, { role: 'subtitle', lineHeight: 1.15 });
    s.text(`item-${i}-label`, item.label, [12, y + 1, 40, 11], {
      role: 'subtitle',
      fontSize: size,
      lineHeight: 1.15,
      valign: 'top',
      ...v.display,
    });
    s.text(`item-${i}-detail`, item.detail, [54, y + 1.5, 40, 11], {
      role: 'body',
      fontSize: 13.5,
      lineHeight: 1.4,
      color: v.c.muted,
      valign: 'top',
    });
  });
  pageNumber(s, options, v.c.muted);
  return { id: options.slideId, title: content.title, elements: s.elements, ...notes(content) };
}

function composeQuote(content: CompositionContent, options: ComposeSlideOptions): DeckSlideV2 {
  const v = voice(options.theme);
  const s = new Slide('quote', options);
  const artwork = artworkFor(content);
  // Artwork variant: the painting takes the left third and the quote moves right of it.
  if (artwork) s.artwork('image', artwork, [0, 0, 32, 100], { x: 0.5, y: 0.4 });
  const x = artwork ? 41 : 13;
  const width = artwork ? 50 : 74;
  s.upright('rule', x - 3, 22, 44, v.c.accent, 2);
  kickerLine(s, v, content.kicker, [x, 12, width, 4.5]);
  const size = fitTypeSize(content.title, [x, 22, width, 44], artwork ? 40 : 44, 28, {
    role: 'title',
    lineHeight: 1.1,
  });
  s.text('title', content.title, [x, 22, width, 44], {
    role: 'title',
    fontSize: size,
    lineHeight: 1.1,
    italic: v.editorial,
    valign: 'top',
    ...v.display,
  });
  if (content.body)
    s.text('body', content.body, [x, 70, artwork ? 46 : 60, 8], {
      role: 'body',
      fontSize: 14,
      color: v.c.muted,
      lineHeight: 1.4,
      valign: 'top',
    });
  content.items.slice(0, 1).forEach((item, i) => {
    s.text(`item-${i}-label`, item.label, [x, 80, 40, 5], {
      role: 'caption',
      fontSize: 12,
      valign: 'top',
      ...v.display,
    });
    s.text(`item-${i}-detail`, item.detail, [x, 85, 40, 4], {
      role: 'caption',
      fontSize: 11,
      color: v.c.muted,
      valign: 'top',
    });
  });
  if (artwork) s.credit(artwork, [x, 89, 40, 6], v.c.muted);
  pageNumber(s, options, v.c.muted);
  return { id: options.slideId, title: content.title, elements: s.elements, ...notes(content, artwork) };
}

function composeClose(content: CompositionContent, options: ComposeSlideOptions): DeckSlideV2 {
  const v = voice(options.theme);
  const s = new Slide('close', options);
  const ground = v.editorial ? v.c.background : v.c.ink;
  const ink = v.editorial ? v.c.ink : v.paper;
  const muted = v.editorial ? v.c.muted : v.c.onInkBody;
  const artwork = artworkFor(content);
  // Art strip variant: a narrow band of the painting along the top edge; the head moves down 2 percent.
  if (artwork) s.artwork('image', artwork, [0, 0, 100, 8], { x: 0.5, y: 0.35 });
  const top = artwork ? 2 : 0;
  kickerLine(s, v, content.kicker, [6, 9 + top, 40, 4.5], v.editorial ? v.c.accent : v.c.onInkBody);
  const size = fitTypeSize(content.title, [6, 14 + top, 60, 18], 44, 32, { role: 'title', lineHeight: 1.02 });
  s.text('title', content.title, [6, 14 + top, 60, 18], {
    role: 'title',
    fontSize: size,
    lineHeight: 1.02,
    valign: 'top',
    color: ink,
    ...v.display,
  });
  const items = content.items.slice(0, 4);
  const layout = columns(items.length);
  // The numerals take the accent only where it clears the display floor on this ground.
  const numeral = (contrastRatio(v.c.accent, ground) ?? 0) >= 3 ? v.c.accent : ink;
  items.forEach((item, i) => {
    const x = 6 + i * layout.pitch;
    s.text(`item-${i}-number`, String(i + 1), [x, 44, 8, 12], {
      role: 'number',
      fontSize: 44,
      color: numeral,
      valign: 'top',
      ...v.display,
    });
    const labelSize = fitTypeSize(item.label, [x, 58, layout.width, 12], 20, 15, {
      role: 'subtitle',
      lineHeight: 1.15,
    });
    s.text(`item-${i}-label`, item.label, [x, 58, layout.width, 12], {
      role: 'subtitle',
      fontSize: labelSize,
      lineHeight: 1.15,
      valign: 'top',
      color: ink,
      ...v.display,
    });
    s.text(`item-${i}-detail`, item.detail, [x, 71, layout.width - 1, 16], {
      role: 'body',
      fontSize: 13.5,
      lineHeight: 1.4,
      valign: 'top',
      color: muted,
    });
  });
  s.rule('rule', 6, 90, 88, v.editorial ? v.c.soft : v.c.onInkRule, 1);
  if (content.body)
    s.text('body', content.body, [6, 92, artwork ? 38 : 60, 5], {
      role: 'caption',
      fontSize: 11,
      color: muted,
      valign: 'top',
    });
  if (artwork) s.credit(artwork, [46, 92, 38, 6], muted, 'right');
  pageNumber(s, options, muted);
  return {
    id: options.slideId,
    title: content.title,
    elements: s.elements,
    background: ground,
    ...notes(content, artwork),
  };
}

/** Speaker notes: the content's own notes, plus the artwork line when a painting was hung. */
function notes(content: CompositionContent, artwork?: CompositionArtwork) {
  if (!artwork) return content.notes?.trim() ? { notes: content.notes } : {};
  return { notes: withArtworkNote(content.notes, artwork) };
}

/** Compose one slide through its composition. */
export function composeSlide(content: CompositionContent, options: ComposeSlideOptions): DeckSlideV2 {
  switch (content.role) {
    case 'cover':
      return composeCover(content, options);
    case 'statement':
      return composeStatement(content, options);
    case 'image-left':
      return composeImageSide(content, options, 'left');
    case 'image-right':
      return composeImageSide(content, options, 'right');
    case 'metrics':
      return composeMetrics(content, options);
    case 'table':
      return composeTable(content, options);
    case 'chart':
      return composeChart(content, options);
    case 'process':
      return composeProcess(content, options);
    case 'comparison':
      return composeComparison(content, options);
    case 'list':
      return composeList(content, options);
    case 'quote':
      return composeQuote(content, options);
    case 'close':
      return composeClose(content, options);
  }
}

export interface ComposeDeckOptions {
  theme: DeckTheme;
  slideIds?: string[];
}

/** Compose a whole deck; slide ids default to `slide-N`. */
export function composeDeck(slides: CompositionContent[], options: ComposeDeckOptions): DeckModelV2 {
  const composed = slides.map((content, index) =>
    composeSlide(content, {
      theme: options.theme,
      index,
      total: slides.length,
      slideId: options.slideIds?.[index] ?? `slide-${index + 1}`,
    }),
  );
  return { kind: 'deck', version: 2, activeSlideId: composed[0].id, theme: options.theme, slides: composed };
}

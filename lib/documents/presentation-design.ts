import { z } from 'zod';
import type { DeckElement, DeckElementV2, DeckModelV2, DeckSlideV2, DeckTheme } from './model';
import {
  buildDeckTheme,
  COMPOSITION_ROLES,
  type CompositionAsset,
  type CompositionChart,
  type CompositionContent,
  type CompositionItem,
  type CompositionRole,
  composeSlide,
  FONT_PAIR_NAMES,
  type FontPairName,
  fontPairOf,
  PALETTE_NAMES,
  type PaletteInput,
  paletteTokens,
  parseSlotName,
} from './presentation-compositions';

// Content and art direction are generated together; geometry is deterministic
// so long prose cannot turn into overlapping, unstyled boxes.
export const presentationBriefSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(1000),
  palette: z.enum(['ink', 'forest', 'clay']),
  slides: z
    .array(
      z.object({
        layout: z.enum(['cover', 'statement', 'metrics', 'columns', 'timeline']),
        title: z.string().min(1).max(90),
        kicker: z.string().max(40),
        body: z.string().max(240),
        items: z
          .array(
            z.object({
              label: z.string().min(1).max(50),
              detail: z.string().max(150),
            }),
          )
          .max(3),
        notes: z.string().max(4000),
      }),
    )
    .min(1)
    .max(30),
});
export type PresentationBrief = z.infer<typeof presentationBriefSchema>;
const palettes = {
  ink: {
    dark: '#182C40',
    paper: '#F5F2EA',
    accent: '#B6533A',
    muted: '#536170',
    panel: '#E7E3D9',
    soft: '#CAD3DB',
  },
  forest: {
    dark: '#183C32',
    paper: '#F3F3E9',
    accent: '#856019',
    muted: '#52665B',
    panel: '#E2E6D8',
    soft: '#CBD9CD',
  },
  clay: {
    dark: '#492E37',
    paper: '#FAF1E8',
    accent: '#A34731',
    muted: '#75605B',
    panel: '#EFDFD3',
    soft: '#E2CBC8',
  },
};

export function composePresentation(brief: PresentationBrief) {
  const colors = palettes[brief.palette];
  const slides = brief.slides.map((source, index) => {
    const id = `slide-${index + 1}`;
    const dark = source.layout === 'cover' || source.layout === 'statement';
    const foreground = dark ? colors.paper : colors.dark;
    const muted = dark ? colors.soft : colors.muted;
    const elements: DeckElement[] = [];
    const text = (
      value: string,
      x: number,
      y: number,
      width: number,
      height: number,
      fontSize: number,
      role: DeckElement['role'] = 'body',
      color = foreground,
    ) => {
      if (value.trim())
        elements.push({
          id: `${id}-e${elements.length}`,
          type: 'text',
          text: value,
          x,
          y,
          width,
          height,
          fontSize,
          role,
          color,
        });
    };
    const shape = (x: number, y: number, width: number, height: number, fill: string) =>
      elements.push({
        id: `${id}-e${elements.length}`,
        type: 'shape',
        role: 'shape',
        x,
        y,
        width,
        height,
        fill,
        color: fill,
      });
    shape(6, 8, 5, 1, dark ? colors.soft : colors.accent);
    text(source.kicker, 6, 11, 88, 6, 12, 'caption', muted);
    text(
      `${String(index + 1).padStart(2, '0')} / ${String(brief.slides.length).padStart(2, '0')}`,
      85,
      91,
      9,
      4,
      10,
      'caption',
      muted,
    );
    if (dark) {
      text(source.title, 6, 26, 85, 31, source.title.length > 60 ? 38 : 46, 'title');
      text(source.body, 6, 62, 76, 20, 20, 'subtitle', muted);
    } else {
      text(source.title, 6, 21, 88, 18, source.title.length > 65 ? 28 : 34, 'title');
      text(source.body, 6, 40, 88, 12, 17, 'subtitle', muted);
    }
    // Cover/statement copy belongs in notes, not hidden in unrendered items.
    if (!dark && source.items.length) {
      const count = source.items.length;
      const width = (88 - (count - 1) * 3) / count;
      source.items.forEach((item, itemIndex) => {
        const x = 6 + itemIndex * (width + 3);
        shape(x, 57, width, 29, colors.panel);
        if (source.layout === 'timeline')
          text(String(itemIndex + 1).padStart(2, '0'), x + 2, 59, width - 4, 5, 12, 'caption', colors.accent);
        text(
          item.label,
          x + 2,
          source.layout === 'timeline' ? 65 : 60,
          width - 4,
          10,
          source.layout === 'metrics' && item.label.length <= 12 ? 32 : 19,
          'title',
          colors.accent,
        );
        text(item.detail, x + 2, 73, width - 4, 11, 13, 'body', colors.muted);
      });
    }
    return {
      id,
      title: source.title,
      background: dark ? colors.dark : colors.paper,
      notes: [source.notes, ...(dark ? source.items.map((item) => `${item.label}: ${item.detail}`) : [])]
        .filter(Boolean)
        .join('\n'),
      elements,
    };
  });
  return { kind: 'deck' as const, version: 1 as const, activeSlideId: slides[0].id, slides };
}

export const PRESENTATION_DESIGN_GUIDANCE = `Design a complete presentation as 16:9 slides. Return finished slide copy, not instructions to create it.
Choose one coherent palette: ink (navy, cream, rust), forest (green, cream, ochre), or clay (plum, ivory, terracotta), matching the user's direction.
Build a narrative: an evocative cover, evidence and outcomes, then a clear takeaway. Vary layouts: cover/statement use a large headline and body; metrics/columns/timeline use up to three label/detail items. Use at least three different layouts for decks of five or more slides. Use metrics for verified numbers, columns for comparisons, timeline for ordered steps. Never invent statistics to fill a layout.
Respect the requested slide count. Write short headlines, concise labels, and supporting details that fit their bounds. Put source attribution, nuances, exact dates/timezones, and fuller explanation in speaker notes. Each slide must contain actual content, never placeholders or a restatement of the user's request. Only attribute events to a date when source timestamps in the user's timezone support it.`;

/* ------------------------------------------------------------------------ */
/* Version 2: the art-direction brief and the composed deck                  */
/* ------------------------------------------------------------------------ */

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** Six colors a custom palette must supply. */
export const deckPaletteColorsSchema = z.object({
  background: hexColor,
  surface: hexColor,
  ink: hexColor,
  muted: hexColor,
  accent: hexColor,
  accentInk: hexColor,
});

export const PRESENTATION_TONES = ['plain', 'warm', 'formal', 'urgent', 'celebratory'] as const;

const briefItemSchema = z.object({
  label: z.string().min(1).max(60),
  detail: z.string().max(160),
  /** A date, owner or unit; shown small where the composition has a slot for it. */
  meta: z.string().max(40).nullish(),
});

export const briefChartSchema = z
  .object({
    type: z.enum(['column', 'bar', 'line', 'pie', 'doughnut']),
    categories: z.array(z.string().min(1).max(40)).min(1).max(8),
    series: z
      .array(z.object({ name: z.string().max(60), values: z.array(z.number()).min(1).max(8) }))
      .min(1)
      .max(2),
    unit: z.string().max(12).nullish(),
    source: z.string().max(200).nullish(),
  })
  .refine((chart) => chart.series.every((series) => series.values.length === chart.categories.length), {
    message: 'Every series needs one value per category.',
    path: ['series'],
  });

const briefImageSchema = z.object({
  alt: z.string().min(1).max(200),
  subject: z.string().max(120),
  /** An owned asset id from the grounding material, when one was supplied. */
  assetId: z.string().max(200).nullish(),
});

export const presentationBriefV2Schema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(1000),
  audience: z.string().max(200),
  purpose: z.string().max(300),
  tone: z.enum(PRESENTATION_TONES),
  palette: z.union([z.enum(PALETTE_NAMES), deckPaletteColorsSchema]),
  fontPair: z.enum(FONT_PAIR_NAMES),
  imagery: z.string().max(200),
  slides: z
    .array(
      z.object({
        role: z.enum(COMPOSITION_ROLES),
        title: z.string().min(1).max(120),
        kicker: z.string().max(40),
        body: z.string().max(320),
        items: z.array(briefItemSchema).max(4),
        notes: z.string().max(4000),
        chart: briefChartSchema.nullish(),
        image: briefImageSchema.nullish(),
        visualRole: z.string().max(200),
      }),
    )
    .min(1)
    .max(30),
});
export type PresentationBriefV2 = z.infer<typeof presentationBriefV2Schema>;

export const PRESENTATION_DESIGN_GUIDANCE_V2 = `Design a complete presentation as 16:9 slides. Return finished slide copy and an art-direction brief, not instructions to create them.
The brief names the audience, the purpose, the tone, one palette, one font pair and short imagery guidance. Palettes: editorial (warm paper, ink navy, rust accent) or signal (cool paper, near-black ink, electric blue). Use a custom six-color set only when the user names colors. Font pairs: serif (Fraunces display with Geist text) or sans (Geist throughout). Editorial with serif is the default.
Every slide has one composition role. cover: title, kicker, one-sentence body, optional image. statement: one sentence that carries the slide, optional support line. image-left and image-right: kicker, title, body, up to three short facts as items, an image request. metrics: title and up to three numbers as items (label is the number, detail is what it measures) with chart data. chart: title, body and chart data; items are up to three callouts. process: title and two to four steps as items (label is the step, meta is the date, detail is one sentence). comparison: title and two to four sides as items. list: title and two to four items. quote: the quote as the title, the attribution as the body. close: title, two to four asks as items, a contact line as the body.
Vary the roles across the deck; use at least four different roles in a deck of five or more slides. Open with a cover and end with a close. Use metrics or chart only when the grounding material supplies the numbers. Never invent numbers; use metrics only when the grounding material supplies them. Never invent citations.
Image requests need alt text and a subject. Only set assetId to an asset id listed in the grounding material. Never reference an outside image address; a slide without an owned image composes as typography.
Respect the requested slide count. Write short headlines, concise labels and details that fit their limits. Speaker notes carry sources, nuance, exact dates with time zones and the fuller explanation. Each slide holds real content, never placeholders or a restatement of the request. Only attribute events to a date when source timestamps support it. Plain language, no emoji.`;

export interface ComposePresentationOptions {
  /** Owned assets the deck may show, in the order slides request them. */
  assets?: CompositionAsset[];
  slideIds?: string[];
}

function briefItems(items: PresentationBriefV2['slides'][number]['items']): CompositionItem[] {
  return items.map((item) => ({
    label: item.label,
    detail: item.detail,
    ...(item.meta ? { meta: item.meta } : {}),
  }));
}

function briefChart(chart: PresentationBriefV2['slides'][number]['chart']): CompositionChart | undefined {
  if (!chart) return undefined;
  return {
    type: chart.type,
    categories: chart.categories,
    series: chart.series,
    ...(chart.unit ? { unit: chart.unit } : {}),
    ...(chart.source ? { source: chart.source } : {}),
  };
}

/** Slide content from the brief; images resolve to owned assets or to nothing. */
export function briefToContents(brief: PresentationBriefV2, options: ComposePresentationOptions = {}) {
  const pool = [...(options.assets ?? [])];
  const takeAsset = (assetId: string | null | undefined) => {
    const byId = assetId ? pool.findIndex((asset) => asset.assetId === assetId) : -1;
    const index = byId >= 0 ? byId : pool.length ? 0 : -1;
    if (index < 0) return undefined;
    return pool.splice(index, 1)[0];
  };
  return brief.slides.map((slide): CompositionContent => {
    const asset = slide.image ? takeAsset(slide.image.assetId) : undefined;
    return {
      role: slide.role,
      title: slide.title,
      ...(slide.kicker.trim() ? { kicker: slide.kicker } : {}),
      ...(slide.body.trim() ? { body: slide.body } : {}),
      items: briefItems(slide.items),
      ...(slide.notes.trim() ? { notes: slide.notes } : {}),
      ...(slide.chart ? { chart: briefChart(slide.chart) } : {}),
      ...(slide.image ? { image: { alt: slide.image.alt, ...(asset ? { asset } : {}) } } : {}),
      ...(slide.role === 'cover' && brief.audience.trim()
        ? { footer: `Prepared for ${brief.audience.trim()}` }
        : {}),
    };
  });
}

/** The brief composed into a version 2 deck through the eleven compositions. */
export function composePresentationV2(
  brief: PresentationBriefV2,
  options: ComposePresentationOptions = {},
): DeckModelV2 {
  const theme = buildDeckTheme(brief.palette, brief.fontPair);
  const contents = briefToContents(brief, options);
  const slides = contents.map((content, index) =>
    composeSlide(content, {
      theme,
      index,
      total: contents.length,
      slideId: options.slideIds?.[index] ?? `slide-${index + 1}`,
    }),
  );
  return { kind: 'deck', version: 2, activeSlideId: slides[0].id, theme, slides };
}

/* Copy repair: the one follow-up call that shortens copy that cannot fit. */

export const copyRepairSchema = z.object({
  fixes: z
    .array(
      z.object({
        slideId: z.string().min(1).max(120),
        /** title, kicker, body, notes, chart.source, or items.N.label / items.N.detail / items.N.meta. */
        field: z.string().min(1).max(40),
        text: z.string().max(400),
      }),
    )
    .max(60),
});
export type CopyRepair = z.infer<typeof copyRepairSchema>['fixes'][number];

const FIELD_PATTERN = /^(title|kicker|body|notes|chart\.source|items\.([0-3])\.(label|detail|meta))$/;

/** The brief field behind a composed element, by the slot name the composer wrote. */
export function briefFieldForElement(element: DeckElementV2): string | null {
  const slot = parseSlotName(element.name)?.slot;
  if (!slot) return null;
  if (slot === 'title' || slot === 'kicker' || slot === 'body') return slot;
  if (slot === 'source') return 'chart.source';
  const item = /^item-(\d)-(label|detail|meta)$/.exec(slot);
  if (item) return `items.${item[1]}.${item[2]}`;
  return null;
}

/** Apply shorter copy to the brief. Unknown slides and fields are ignored; numbers never change. */
export function applyCopyRepairs(
  brief: PresentationBriefV2,
  slideIds: string[],
  fixes: CopyRepair[],
): PresentationBriefV2 {
  const next = structuredClone(brief);
  for (const fix of fixes) {
    const index = slideIds.indexOf(fix.slideId);
    const match = FIELD_PATTERN.exec(fix.field);
    if (index < 0 || !match) continue;
    const slide = next.slides[index];
    if (!slide) continue;
    if (match[1] === 'title') {
      if (fix.text.trim()) slide.title = fix.text.slice(0, 120);
    } else if (match[1] === 'kicker') slide.kicker = fix.text.slice(0, 40);
    else if (match[1] === 'body') slide.body = fix.text.slice(0, 320);
    else if (match[1] === 'notes') slide.notes = fix.text.slice(0, 4000);
    else if (match[1] === 'chart.source') {
      if (slide.chart) slide.chart.source = fix.text.slice(0, 200);
    } else {
      const item = slide.items[Number(match[2])];
      if (!item) continue;
      if (match[3] === 'label') {
        if (fix.text.trim()) item.label = fix.text.slice(0, 60);
      } else if (match[3] === 'detail') item.detail = fix.text.slice(0, 160);
      else item.meta = fix.text.slice(0, 40);
    }
  }
  return next;
}

/* Restyle: theme, palette, fonts and layout change; facts, charts, notes and order stay. */

export interface RestyleOptions {
  palette?: PaletteInput;
  fontPair?: FontPairName;
  scope: 'theme' | 'theme-and-layout';
  lockedElementIds?: string[];
}

export interface ExtractedSlide {
  content: CompositionContent;
  /** Slot name to the existing element id, so a recomposition keeps ids where content maps one to one. */
  ids: Partial<Record<string, string>>;
}

type TextElement = Extract<DeckElementV2, { type: 'text' }>;

function sameColor(a: string | undefined, b: string | undefined) {
  return Boolean(a && b) && String(a).toUpperCase() === String(b).toUpperCase();
}

function chartOf(element: Extract<DeckElementV2, { type: 'chart' }>): CompositionChart {
  return {
    type: element.chart,
    categories: element.categories,
    series: element.series,
    ...(element.unit ? { unit: element.unit } : {}),
    ...(element.source ? { source: element.source } : {}),
  };
}

function assetOf(element: Extract<DeckElementV2, { type: 'image' }>): CompositionAsset {
  return {
    assetId: element.assetId,
    src: element.src ?? '',
    alt: element.alt,
    ...(element.aspect ? { aspect: element.aspect } : {}),
    ...(element.source ? { source: element.source } : {}),
    ...(element.focal ? { focal: element.focal } : {}),
  };
}

/** Role of a slide the composer did not write, from its structure. */
export function guessSlideRole(
  slide: DeckSlideV2,
  index: number,
  total: number,
  theme: DeckTheme,
  facts: { items: number; chart: boolean; imageSide: 'left' | 'right' | null; title: string; body: boolean },
): CompositionRole {
  if (index === 0) return 'cover';
  if (facts.imageSide === 'left') return 'image-left';
  if (facts.imageSide === 'right') return 'image-right';
  if (facts.chart) return facts.items >= 2 ? 'metrics' : 'chart';
  const ellipses = slide.elements.filter((e) => e.type === 'shape' && e.shape === 'ellipse').length;
  const monoNumbers = slide.elements.filter(
    (e) => e.type === 'text' && e.font === 'mono' && /^\d{1,2}$/.test(e.text.trim()),
  ).length;
  if (ellipses >= 2 || monoNumbers >= 2) return 'process';
  const panels = slide.elements.filter(
    (e) => e.type === 'shape' && (e.shape ?? 'rect') !== 'ellipse' && e.width >= 30 && e.height >= 30,
  ).length;
  if (panels >= 2 && facts.items >= 2) return 'comparison';
  if (index === total - 1 && facts.items >= 1) return 'close';
  if (facts.items >= 2) return 'list';
  if (/^["“‘']/.test(facts.title.trim())) return 'quote';
  if (slide.background && !sameColor(slide.background, theme.colors.background)) return 'statement';
  return facts.items ? 'list' : 'statement';
}

function readingOrder(a: DeckElementV2, b: DeckElementV2) {
  return a.y - b.y || a.x - b.x;
}

/** A page or step number the composer writes again: one or two digits in the mono slot or a small number. */
function isIndexMarker(element: TextElement) {
  if (!/^\d{1,2}$/.test(element.text.trim())) return false;
  if (element.font === 'mono') return true;
  return element.role === 'caption' && (element.fontSize ?? 12) <= 14;
}

/**
 * Everything a slide says, so a composition can lay it out again. Returns null
 * when the slide holds more than one composition can carry (two charts, two
 * images, more than four items); such a slide keeps its layout.
 */
export function extractSlideContent(
  slide: DeckSlideV2,
  index: number,
  total: number,
  theme: DeckTheme,
): ExtractedSlide | null {
  const ids: Partial<Record<string, string>> = {};
  let role: CompositionRole | null = null;
  let title: string | undefined;
  let kicker: string | undefined;
  let body: string | undefined;
  let footer: string | undefined;
  let sourceLine: string | undefined;
  let chart: CompositionChart | undefined;
  let image: CompositionContent['image'];
  const items = new Map<number, CompositionItem>();
  const unnamed: DeckElementV2[] = [];
  for (const element of slide.elements) {
    const slot = parseSlotName(element.name);
    if (!slot) {
      unnamed.push(element);
      continue;
    }
    role ??= slot.role;
    ids[slot.slot] = element.id;
    if (element.type === 'text') {
      if (slot.slot === 'title') title = element.text;
      else if (slot.slot === 'kicker') kicker = element.text;
      else if (slot.slot === 'body') body = element.text;
      else if (slot.slot === 'foot') footer = element.text;
      else if (slot.slot === 'source') sourceLine = element.text;
      else {
        const item = /^item-(\d)-(label|detail|meta)$/.exec(slot.slot);
        if (item) {
          const current = items.get(Number(item[1])) ?? { label: '', detail: '' };
          if (item[2] === 'label') current.label = element.text;
          else if (item[2] === 'detail') current.detail = element.text;
          else current.meta = element.text;
          items.set(Number(item[1]), current);
        }
      }
    } else if (element.type === 'chart') {
      if (chart) return null;
      chart = chartOf(element);
    } else if (element.type === 'image') {
      if (image) return null;
      image = { alt: element.alt, asset: assetOf(element) };
    }
  }
  // Elements the composer did not write: text becomes content, charts and images fill free slots.
  const texts = unnamed.filter((e): e is TextElement => e.type === 'text' && e.text.trim().length > 0);
  texts.sort(readingOrder);
  let imageSide: 'left' | 'right' | null = null;
  for (const element of unnamed) {
    if (element.type === 'chart') {
      if (chart) return null;
      chart = chartOf(element);
      ids.chart = element.id;
    } else if (element.type === 'image' && !element.decorative) {
      if (image) return null;
      image = { alt: element.alt, asset: assetOf(element) };
      ids.image = element.id;
      imageSide = element.x + element.width / 2 < 50 ? 'left' : 'right';
    }
  }
  const remaining: TextElement[] = [];
  for (const element of texts) {
    if (isIndexMarker(element)) continue;
    if (!title && element.role === 'title') {
      title = element.text;
      ids.title = element.id;
    } else if (!kicker && element.role === 'kicker') {
      kicker = element.text;
      ids.kicker = element.id;
    } else remaining.push(element);
  }
  if (!title) {
    const largest = [...remaining].sort((a, b) => (b.fontSize ?? 16) - (a.fontSize ?? 16))[0];
    if (largest) {
      title = largest.text;
      ids.title = largest.id;
      remaining.splice(remaining.indexOf(largest), 1);
    }
  }
  if (!body) {
    const prose = remaining.find(
      (e) => (e.role === 'body' || e.role === 'subtitle') && e.text.length > 40 && e.width >= 30,
    );
    if (prose) {
      body = prose.text;
      ids.body = prose.id;
      remaining.splice(remaining.indexOf(prose), 1);
    }
  }
  // Labels (numbers and subtitles) own the texts stacked under them in their column.
  const used = new Set<string>();
  const isLabel = (e: TextElement) => e.role === 'number' || e.role === 'subtitle';
  let next = items.size ? Math.max(...items.keys()) + 1 : 0;
  for (const label of remaining) {
    if (!isLabel(label) || used.has(label.id)) continue;
    if (next >= 4) return null;
    used.add(label.id);
    const column = remaining
      .filter(
        (e) =>
          !used.has(e.id) &&
          e !== label &&
          Math.abs(e.x - label.x) <= 1.5 &&
          e.y > label.y &&
          e.width <= label.width * 1.6,
      )
      .sort(readingOrder);
    const stop = column.findIndex((e) => isLabel(e));
    const under = stop >= 0 ? column.slice(0, stop) : column;
    // A small bare number with nothing under it is a step index the composer writes again.
    if (/^\d{1,2}$/.test(label.text.trim()) && (label.fontSize ?? 64) <= 48 && !under.length) continue;
    const item: CompositionItem = { label: label.text, detail: '' };
    ids[`item-${next}-label`] = label.id;
    const detail = under.find((e) => e.role !== 'caption') ?? under[0];
    if (detail) {
      item.detail = detail.text;
      ids[`item-${next}-detail`] = detail.id;
      used.add(detail.id);
      const meta = under.find((e) => e !== detail && e.role === 'caption');
      if (meta) {
        item.meta = meta.text;
        ids[`item-${next}-meta`] = meta.id;
        used.add(meta.id);
      }
    }
    items.set(next, item);
    next += 1;
  }
  for (const element of remaining) {
    if (used.has(element.id)) continue;
    if (element.role === 'caption' && element.y >= 85 && !footer) {
      footer = element.text;
      ids.foot = element.id;
      continue;
    }
    if (next >= 4) return null;
    items.set(next, { label: element.text, detail: '' });
    ids[`item-${next}-label`] = element.id;
    next += 1;
  }
  if (!title && !body && !items.size && !chart && !image) return null;
  const orderedItems = [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
  const resolvedTitle = title ?? slide.title ?? '';
  const resolvedRole =
    role ??
    guessSlideRole(slide, index, total, theme, {
      items: orderedItems.length,
      chart: Boolean(chart),
      imageSide,
      title: resolvedTitle,
      body: Boolean(body),
    });
  // A foot line under a chart is its visible source; elsewhere outside the cover it is the body copy.
  if (footer && chart && !sourceLine) {
    sourceLine = footer;
    if (ids.foot) ids.source = ids.foot;
    footer = undefined;
  } else if (resolvedRole !== 'cover' && footer && !body) {
    body = footer;
    if (ids.foot) ids.body = ids.foot;
    footer = undefined;
  }
  return {
    content: {
      role: resolvedRole,
      title: resolvedTitle,
      ...(kicker ? { kicker } : {}),
      ...(body ? { body } : {}),
      items: orderedItems,
      ...(slide.notes ? { notes: slide.notes } : {}),
      ...(chart ? { chart } : {}),
      ...(image ? { image } : {}),
      ...(footer ? { footer } : {}),
      ...(sourceLine ? { sourceLine } : {}),
    },
    ids,
  };
}

/**
 * Restyle a version 2 deck. `theme` moves the deck theme and every color that
 * equals an old theme token to the new token, leaving explicit colors that
 * differ. `theme-and-layout` also recomposes each slide through its
 * composition, keeping slide ids, mapped element ids, notes, order and locked
 * elements exactly. Facts, chart data and notes never change.
 */
export function restyleDeck(model: DeckModelV2, options: RestyleOptions): DeckModelV2 {
  const oldTheme = model.theme;
  const oldTokens = paletteTokens(oldTheme.colors);
  const theme = buildDeckTheme(options.palette ?? oldTheme.colors, options.fontPair ?? fontPairOf(oldTheme));
  const newTokens = paletteTokens(theme.colors);
  const lockedIds = new Set(options.lockedElementIds ?? []);
  const isLocked = (element: DeckElementV2) => Boolean(element.locked) || lockedIds.has(element.id);
  const remap = (color: string | undefined) => {
    if (!color) return color;
    for (const key of Object.keys(oldTokens) as (keyof typeof oldTokens)[])
      if (sameColor(oldTokens[key], color)) return newTokens[key];
    return color;
  };
  const recolor = (element: DeckElementV2): DeckElementV2 => {
    if (isLocked(element)) return element;
    if (element.type === 'text')
      return {
        ...element,
        ...(element.color ? { color: remap(element.color) } : {}),
        ...(element.fill ? { fill: remap(element.fill) } : {}),
      };
    if (element.type === 'shape')
      return {
        ...element,
        ...(element.fill ? { fill: remap(element.fill) } : {}),
        ...(element.stroke ? { stroke: { ...element.stroke, color: remap(element.stroke.color)! } } : {}),
      };
    if (element.type === 'line')
      return { ...element, stroke: { ...element.stroke, color: remap(element.stroke.color)! } };
    if (element.type === 'chart' && element.colors)
      return { ...element, colors: element.colors.map((c) => remap(c)!) };
    return element;
  };
  const total = model.slides.length;
  const slides = model.slides.map((slide, index): DeckSlideV2 => {
    const themed: DeckSlideV2 = {
      ...slide,
      ...(slide.background ? { background: remap(slide.background) } : {}),
      elements: slide.elements.map(recolor),
    };
    if (options.scope === 'theme') return themed;
    const extracted = extractSlideContent(slide, index, total, oldTheme);
    if (!extracted) return themed;
    const locked = slide.elements.filter(isLocked);
    const lockedSet = new Set(locked.map((element) => element.id));
    const composed = composeSlide(extracted.content, {
      theme,
      index,
      total,
      slideId: slide.id,
      ids: extracted.ids,
    });
    return {
      ...composed,
      title: slide.title,
      ...(slide.notes !== undefined ? { notes: slide.notes } : {}),
      ...(slide.backgroundImage ? { backgroundImage: slide.backgroundImage } : {}),
      elements: [...composed.elements.filter((element) => !lockedSet.has(element.id)), ...locked],
    };
  });
  return { ...model, theme, slides };
}

/**
 * Words that ask for a change of appearance rather than content. This gate is
 * conservative; a model classification confirms the intent before a restyle
 * proposal replaces a content edit.
 */
export const RESTYLE_INTENT_PATTERN =
  /\b(re-?styl\w*|re-?design\w*|re-?theme\w*|themes?|look|looks|palettes?|colou?rs?|colou?r scheme|fonts?|typography|typefaces?|layouts?|styling|appearance|visual style|editorial|signal|serif|sans)\b/i;

export function mentionsRestyle(instruction: string) {
  return RESTYLE_INTENT_PATTERN.test(instruction);
}

/** What a classification of a restyle request returns. */
export const restyleClassificationSchema = z.object({
  /** True only when the request changes appearance and asks for no content change. */
  restyle: z.boolean(),
  palette: z.enum(['editorial', 'signal', 'custom', 'keep']),
  colors: deckPaletteColorsSchema.nullish(),
  fontPair: z.enum(['serif', 'sans', 'keep']),
  scope: z.enum(['theme', 'theme-and-layout']),
  summary: z.string().min(1).max(300),
});
export type RestyleClassification = z.infer<typeof restyleClassificationSchema>;

export const RESTYLE_CLASSIFIER_GUIDANCE = `Decide whether an instruction about an existing presentation asks only for a change of appearance: theme, palette, colors, fonts, typography or layout. Answer restyle=true only when the instruction asks for no change to the words, numbers, charts, notes or slide order. Map the request: palette editorial (warm paper, navy ink, rust accent), signal (cool paper, near-black ink, electric blue), custom when the user names colors (then fill colors with six hex values), or keep. fontPair serif (Fraunces display) or sans (Geist), or keep. scope is theme for color and font changes and theme-and-layout when the user asks for a new layout, a redesign or a fresh look. Write a one-sentence plain summary of the change; do not use the word AI.`;

/** The restyle operation a classification maps to, or null when it is not a restyle. */
export function restyleOperationFor(classification: RestyleClassification) {
  if (!classification.restyle) return null;
  const palette =
    classification.palette === 'custom' && classification.colors
      ? classification.colors
      : classification.palette === 'editorial' || classification.palette === 'signal'
        ? classification.palette
        : undefined;
  const fontPair = classification.fontPair === 'keep' ? undefined : classification.fontPair;
  if (!palette && !fontPair && classification.scope === 'theme') return null;
  return {
    op: 'deck_restyle' as const,
    ...(palette ? { palette } : {}),
    ...(fontPair ? { fontPair } : {}),
    scope: classification.scope,
  };
}

/** Honor an explicit slide count even when a provider returns a valid but incomplete outline. */
export interface PresentationSlideConstraints {
  min: number;
  max: number;
  exact?: number;
}

/** Interpret bounded requests without turning their endpoints into exact counts. */
export function requestedPresentationSlideConstraints(
  instruction: string,
): PresentationSlideConstraints | undefined {
  const words = [
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
  ];
  const number = '(\\d{1,2}|' + words.join('|') + ')';
  const pattern = new RegExp(
    '\\b(?:(up to|at most|no more than|at least|no fewer than|more than|less than|fewer than|exactly|between)\\s+)?' +
      number +
      '(?:\\s*(?:[-–—]|to|and)\\s*' +
      number +
      ')?[ -]+slides?\\b',
    'g',
  );
  const matches = [...instruction.toLowerCase().matchAll(pattern)];
  if (!matches.length) return undefined;
  let min = 1,
    max = 30;
  for (const match of matches) {
    const value = (raw: string) => Number(raw) || words.indexOf(raw) + 1;
    const count = value(match[2]);
    if (count < 1 || count > 30) continue;
    if (match[3]) {
      min = count;
      max = value(match[3]);
    } else if (['up to', 'at most', 'no more than'].includes(match[1])) max = count;
    else if (['at least', 'no fewer than'].includes(match[1])) min = count;
    else if (match[1] === 'more than') min = count + 1;
    else if (['less than', 'fewer than'].includes(match[1])) max = count - 1;
    else {
      min = count;
      max = count;
    }
  }
  return { min, max, ...(min === max ? { exact: min } : {}) };
}

export function requestedPresentationSlideCount(instruction: string) {
  return requestedPresentationSlideConstraints(instruction)?.exact;
}

export function presentationSlideCountMatches(instruction: string, count: number) {
  const constraint = requestedPresentationSlideConstraints(instruction);
  return !constraint || (count >= constraint.min && count <= constraint.max);
}

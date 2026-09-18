import { z } from 'zod';
import type { DeckElement, DeckElementV2, DeckModelV2, DeckSlideV2, DeckTheme } from './model';
import {
  ARTWORK_PREFIX,
  buildDeckTheme,
  COMPOSITION_ROLES,
  type CompositionArtwork,
  type CompositionAsset,
  type CompositionChart,
  type CompositionContent,
  type CompositionItem,
  type CompositionRole,
  composeSlide,
  FONT_PAIR_NAMES,
  type FontPairName,
  fontPairOf,
  isArtworkSource,
  PALETTE_NAMES,
  type PaletteInput,
  paletteTokens,
  parseSlotName,
  stripArtworkNotes,
  withArtworkNote,
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

export const briefTableSchema = z
  .object({
    headers: z.array(z.string().min(1).max(40)).min(2).max(4),
    rows: z
      .array(z.array(z.string().max(60)).min(2).max(4))
      .min(1)
      .max(6),
    source: z.string().max(200).nullish(),
  })
  .refine((table) => table.rows.every((row) => row.length === table.headers.length), {
    message: 'Each row needs one cell per header.',
    path: ['rows'],
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
        items: z.array(briefItemSchema).max(4).default([]),
        notes: z.string().max(4000),
        chart: briefChartSchema.nullish(),
        table: briefTableSchema.nullish(),
        image: briefImageSchema.nullish(),
        visualRole: z.string().max(200),
      }),
    )
    .min(1)
    .max(30),
});
export type PresentationBriefV2 = z.infer<typeof presentationBriefV2Schema>;

// Authoring copy is reviewed before compact layout budgets are enforced.
// Structure stays bounded; a paragraph over 320 characters is repairable input.
const authoringCopy = {
  title: z.string().min(1).max(2000),
  // Chart/table/statement slides can intentionally omit supporting copy.
  // Normalize absent text before review, without inventing prose or touching data.
  kicker: z
    .string()
    .max(1000)
    .nullish()
    .transform((value) => value ?? ''),
  body: z
    .string()
    .max(8000)
    .nullish()
    .transform((value) => value ?? ''),
  notes: z
    .string()
    .max(12000)
    .nullish()
    .transform((value) => value ?? ''),
};
// Leave room below the 50,000-character persisted slide-note limit for
// preservation labels and artwork credits. Count JSON escaping as well.
export function fitsPresentationPreservationBudget(slide: object) {
  return JSON.stringify(slide).length <= 40_000;
}
export const PRESENTATION_PRESERVATION_BUDGET_MESSAGE =
  'A slide may contain at most 40,000 serialized characters of source material so originals fit in speaker notes. Condense this slide or reference a supporting document.';
export const presentationAuthoringSchema = presentationBriefSchema.extend({
  slides: z
    .array(
      presentationBriefSchema.shape.slides.element
        .extend({
          ...authoringCopy,
          items: z
            .array(z.object({ label: z.string().max(1000), detail: z.string().max(4000) }))
            .max(12)
            .describe('Aim for at most 3 concise items. Excess draft items are grouped during slide review.'),
        })
        .refine(fitsPresentationPreservationBudget, PRESENTATION_PRESERVATION_BUDGET_MESSAGE)
        .describe(PRESENTATION_PRESERVATION_BUDGET_MESSAGE),
    )
    .min(1)
    .max(30),
});
export const presentationAuthoringV2Schema = presentationBriefV2Schema.extend({
  slides: z
    .array(
      presentationBriefV2Schema.shape.slides.element
        .extend({
          ...authoringCopy,
          items: z
            .array(
              briefItemSchema.extend({
                // Empty draft labels are repaired from their own supporting copy
                // during review; compact/final labels still require content.
                label: z.string().max(1000),
                detail: z.string().max(4000),
                meta: z.string().max(1000).nullish(),
              }),
            )
            .max(12)
            .describe(
              'Visible budget: 4 items for lists/process/comparison/metrics/image/close; 3 chart callouts; 1 quote context item; no items for cover/statement/table. Up to 12 draft items can be grouped during review. Put source detail in notes.',
            )
            .default([]),
        })
        .refine(fitsPresentationPreservationBudget, PRESENTATION_PRESERVATION_BUDGET_MESSAGE)
        .describe(PRESENTATION_PRESERVATION_BUDGET_MESSAGE),
    )
    .min(1)
    .max(30),
});

export const PRESENTATION_DESIGN_GUIDANCE_V2 = `Design a complete presentation as 16:9 slides. Return finished slide copy and an art-direction brief, not instructions to create them.
The brief names the audience, the purpose, the tone, one palette, one font pair and short imagery guidance. imagery is artwork-search subject context, for example "harbor, ships, dusk", not a deck-wide visual mode. Use each slide's image.subject for its specific visual direction. Keep supplied images and data visuals available regardless of artwork; the caller can explicitly exclude artwork with artwork=none. Honor the user's confirmed presentation choices. Palettes: editorial (warm paper and rust), signal (crisp blue), grove (botanical greens), lagoon (teal), dusk (violet), rose (warm rose), sand (ochre), slate (blue-grey). Use a custom six-color set only when the user names colors. Font pairs: serif (Fraunces with Geist), sans (Geist), literary (Instrument Serif with Geist), humanist (Manrope), grotesk (Space Grotesk with Geist), mono (Geist Mono with Geist). Editorial with serif is the fallback only when the user delegates design choices.
Build a spirited, evidence-led story: open with a specific hook, establish the stakes, develop turning points and contrasts, and close with an earned takeaway. Write active, claim-led headlines that move the story forward; keep the tone appropriate to the subject, with no invented drama, quotes or causal claims. Alternate intense evidence slides with brief moments of reflection. Avoid repeating the same layout or merely listing facts chronologically.
Every slide has one starting composition role. A separate model art-direction pass designs its native geometry from the actual content; these compositions are safe fallbacks, not creative limits. Make the story and visual hierarchy specific enough to inspire a distinctive layout. cover: title, kicker, one-sentence body, optional image; audience becomes the footer. statement: one sentence that carries the slide, optional support line. image-left and image-right: kicker, title, body, up to four short facts as items, an image request. image-top: a wide image above a two-column headline and explanation, at most two facts. image-bottom: headline and explanation first, wide image below, at most two facts. image-auto: let the renderer choose among image-left/right/top/bottom from image aspect ratio and copy density; prefer it when geometry is not specified. Choose layouts from the content and story beat rather than asking another question. Keep generous gutters; never place body copy beneath an image or extend it into the image area. metrics: title and up to four numbers as items (label is the number, detail is what it measures) with chart data. chart: title, body and chart data; items are up to three callouts. process: title and two to four steps as items (label is the step, meta is the date, detail is one sentence). comparison: title and two to four sides as items. list: title and two to four items. quote: the quote as the title, the attribution as the body, at most one context item. close: title, two to four asks as items, a contact line as the body. Leave items empty on cover, statement and table slides.
Before submitting EACH slide, check its role-specific item budget and every field: title <=120 characters, kicker <=40, body <=320, item label <=60, detail <=160, meta <=40. These are ceilings, not targets: chart callouts and metric captions should be especially short. Group related findings into a single takeaway when there are too many; keep the exact evidence, individual findings and citations in notes. Preserve the requested slide count. Use a short audience name and a short source caption; full citations belong in notes. The larger authoring schema is a recovery allowance, not a target density.
Vary the roles across the deck; use at least four different roles in a deck of five or more slides. Open with a cover and end with a close. Use metrics or chart only when the grounding material supplies the numbers. Never invent numbers; use metrics only when the grounding material supplies them. Never invent citations.
Use a content-led mix of relevant credited artwork, user-provided images, and evidence-backed charts/tables in the same deck. No mutually exclusive imagery mode is required. Prioritize relevant supplied images; artwork fills other appropriate image slots without replacing images or data visuals. Do not force all visual types onto every slide. Image requests need alt text and a subject. Only set assetId to an asset id listed in the grounding material. Never reference an outside image address; a slide without an owned image composes as typography.
Use role table for precise comparisons with headers (2–4), rows (1–6), and a source caption. Use real chart data for trends or numerical comparisons. Choose a visual that proves the slide takeaway; never invent data or substitute prose for a chart. Respect the requested slide count. Write short headlines, concise labels and details that fit their limits. Speaker notes carry sources, nuance, exact dates with time zones and the fuller explanation. Each slide holds real content, never placeholders or a restatement of the request. Only attribute events to a date when source timestamps support it. Plain language, no emoji.`;

/** The compositions that hang a painting when no owned image takes the slot. */
export const ARTWORK_ROLES: readonly CompositionRole[] = [
  'cover',
  'statement',
  'image-left',
  'image-right',
  'image-top',
  'image-bottom',
  'image-auto',
  'quote',
  'close',
];

export interface ComposePresentationOptions {
  /** Owned assets the deck may show, in the order slides request them. */
  assets?: CompositionAsset[];
  slideIds?: string[];
  /** Credited paintings by slide index, for the slides the imagery plan chose. */
  artworks?: Partial<Record<number, CompositionArtwork>>;
  /** Deck-wide imagery record written to the theme when artwork is present. */
  imagery?: DeckTheme['imagery'];
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
  return brief.slides.map((slide, index): CompositionContent => {
    const asset = slide.image ? takeAsset(slide.image.assetId) : undefined;
    const artwork = !asset && ARTWORK_ROLES.includes(slide.role) ? options.artworks?.[index] : undefined;
    return {
      role: slide.role,
      title: slide.title,
      ...(slide.kicker.trim() ? { kicker: slide.kicker } : {}),
      ...(slide.body.trim() ? { body: slide.body } : {}),
      items: briefItems(slide.items),
      ...(slide.notes.trim() ? { notes: slide.notes } : {}),
      ...(slide.chart ? { chart: briefChart(slide.chart) } : {}),
      ...(slide.table ? { table: slide.table } : {}),
      ...(slide.image ? { image: { alt: slide.image.alt, ...(asset ? { asset } : {}) } } : {}),
      ...(artwork ? { artwork } : {}),
      ...(slide.role === 'cover' && brief.audience.trim()
        ? { footer: `Prepared for ${brief.audience.trim()}` }
        : {}),
    };
  });
}

/** The brief composed into a version 2 deck through the designed compositions. */
export function composePresentationV2(
  brief: PresentationBriefV2,
  options: ComposePresentationOptions = {},
): DeckModelV2 {
  const theme = buildDeckTheme(brief.palette, brief.fontPair);
  const contents = briefToContents(brief, options);
  if (options.imagery && contents.some((content) => content.artwork)) theme.imagery = options.imagery;
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
  if (slot === 'source')
    return parseSlotName(element.name)?.role === 'table' ? 'table.source' : 'chart.source';
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
  /** paintings: hang the supplied artworks on slides that have none. none: remove every painting; user images stay. */
  imagery?: 'paintings' | 'none';
  /** Credited paintings by slide id, resolved before the restyle runs. */
  artworks?: Partial<Record<string, CompositionArtwork>>;
  /** Deck-wide imagery record written to the theme when paintings are added. */
  imageryTheme?: DeckTheme['imagery'];
}

export interface ExtractedSlide {
  content: CompositionContent;
  /** Slot name to the existing element id, so a recomposition keeps ids where content maps one to one. */
  ids: Partial<Record<string, string>>;
  /** True when the slide background image is the composer's painting rather than the user's own. */
  backgroundIsArtwork: boolean;
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
  // Table cells are deliberate grid geometry; preserve it through restyles.
  if (slide.elements.some((element) => parseSlotName(element.name)?.role === 'table')) return null;
  const ids: Partial<Record<string, string>> = {};
  let role: CompositionRole | null = null;
  let title: string | undefined;
  let kicker: string | undefined;
  let body: string | undefined;
  let footer: string | undefined;
  let sourceLine: string | undefined;
  let chart: CompositionChart | undefined;
  let image: CompositionContent['image'];
  let artwork: CompositionArtwork | undefined;
  const items = new Map<number, CompositionItem>();
  const unnamed: DeckElementV2[] = [];
  const artworkNote = (slide.notes ?? '').split('\n').find((line) => line.startsWith(ARTWORK_PREFIX));
  for (const element of slide.elements) {
    const slot = parseSlotName(element.name);
    if (!slot) {
      unnamed.push(element);
      continue;
    }
    role ??= slot.role;
    ids[slot.slot] = element.id;
    if (slot.slot === 'credit' || slot.slot === 'veil') continue;
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
      if (isArtworkSource(element.source)) {
        artwork = { asset: assetOf(element), credit: element.source!.slice(ARTWORK_PREFIX.length) };
        continue;
      }
      if (image) return null;
      image = { alt: element.alt, asset: assetOf(element) };
    }
  }
  // The painting behind a statement lives in the background; the notes line names it.
  const backgroundIsArtwork = Boolean(slide.backgroundImage && artworkNote && !artwork);
  if (backgroundIsArtwork && slide.backgroundImage) {
    artwork = {
      asset: { assetId: slide.backgroundImage.assetId, src: slide.backgroundImage.src ?? '' },
      credit: artworkNote!.slice(ARTWORK_PREFIX.length),
    };
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
  if (!title && !body && !items.size && !chart && !image && !artwork) return null;
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
      ...(stripArtworkNotes(slide.notes) ? { notes: stripArtworkNotes(slide.notes) } : {}),
      ...(chart ? { chart } : {}),
      ...(image ? { image } : {}),
      ...(artwork ? { artwork } : {}),
      ...(footer ? { footer } : {}),
      ...(sourceLine ? { sourceLine } : {}),
    },
    ids,
    backgroundIsArtwork,
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
  if (options.imagery !== 'none' && oldTheme.imagery) theme.imagery = oldTheme.imagery;
  const newTokens = paletteTokens(theme.colors);
  let hung = 0;
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
    const extracted = extractSlideContent(slide, index, total, oldTheme);
    // Imagery changes decide which slides recompose under the theme scope.
    let artwork = extracted?.content.artwork;
    let imageryChange = false;
    if (options.imagery === 'none' && artwork) {
      artwork = undefined;
      imageryChange = true;
    } else if (options.imagery === 'paintings' && extracted && !artwork && !extracted.content.image?.asset) {
      const supplied = options.artworks?.[slide.id];
      if (supplied && ARTWORK_ROLES.includes(extracted.content.role)) {
        artwork = supplied;
        imageryChange = true;
        hung += 1;
      }
    }
    if (!extracted || (options.scope === 'theme' && !imageryChange)) return themed;
    const locked = slide.elements.filter(isLocked);
    const lockedSet = new Set(locked.map((element) => element.id));
    const { artwork: _previous, ...rest } = extracted.content;
    const composed = composeSlide(
      { ...rest, ...(artwork ? { artwork } : {}) },
      { theme, index, total, slideId: slide.id, ids: extracted.ids },
    );
    const keepBackground = slide.backgroundImage && !extracted.backgroundIsArtwork;
    // Notes keep their text; only the composer's artwork line comes or goes. Empty notes stay as they were.
    const stripped = withArtworkNote(slide.notes, artwork);
    const notes = stripped || (slide.notes === '' ? '' : undefined);
    return {
      ...composed,
      title: slide.title,
      ...(notes !== undefined ? { notes } : {}),
      ...(composed.backgroundImage
        ? { backgroundImage: composed.backgroundImage }
        : keepBackground
          ? { backgroundImage: slide.backgroundImage }
          : {}),
      elements: [...composed.elements.filter((element) => !lockedSet.has(element.id)), ...locked],
    };
  });
  // The theme records paintings only once at least one hangs in the deck.
  if (options.imagery === 'paintings' && hung) theme.imagery = options.imageryTheme ?? { mode: 'paintings' };
  return { ...model, theme, slides };
}

/**
 * Words that ask for a change of appearance rather than content. This gate is
 * conservative; a model classification confirms the intent before a restyle
 * proposal replaces a content edit.
 */
export const RESTYLE_INTENT_PATTERN =
  /\b(re-?styl\w*|re-?design\w*|re-?theme\w*|themes?|look|looks|palettes?|colou?rs?|colou?r scheme|fonts?|typography|typefaces?|layouts?|styling|appearance|visual style|editorial|signal|serif|sans|paintings?|artworks?|imagery)\b/i;

export function mentionsRestyle(instruction: string) {
  return RESTYLE_INTENT_PATTERN.test(instruction);
}

/** What a classification of a restyle request returns. */
export const restyleClassificationSchema = z.object({
  /** True only when the request changes appearance and asks for no content change. */
  restyle: z.boolean(),
  palette: z.enum([...PALETTE_NAMES, 'custom', 'keep']),
  colors: deckPaletteColorsSchema.nullish(),
  fontPair: z.enum([...FONT_PAIR_NAMES, 'keep']),
  scope: z.enum(['theme', 'theme-and-layout']),
  /** paintings: add public-domain paintings. none: remove them. keep: leave imagery as it is. */
  imagery: z.enum(['paintings', 'none', 'keep']).nullish(),
  summary: z.string().min(1).max(300),
});
export type RestyleClassification = z.infer<typeof restyleClassificationSchema>;

export const RESTYLE_CLASSIFIER_GUIDANCE = `Decide whether an instruction about an existing presentation asks only for a change of appearance: theme, palette, colors, fonts, typography or layout. Answer restyle=true only when the instruction asks for no change to the words, numbers, charts, notes or slide order. Map the request: palette editorial (warm paper, navy ink, rust accent), signal (cool paper, near-black ink, electric blue), grove (green), lagoon (teal), dusk (violet), rose (pink), sand (ochre), slate (blue-grey), custom when the user names colors (then fill colors with six hex values), or keep. fontPair serif (Fraunces display), sans (Geist), literary (Instrument Serif), humanist (Manrope), grotesk (Space Grotesk), mono (Geist Mono), or keep. scope is theme for color and font changes and theme-and-layout when the user asks for a new layout, a redesign or a fresh look. imagery is paintings when the user asks for artwork, paintings or pictures on the slides, none when the user asks to remove artwork, and keep otherwise. Write a one-sentence plain summary of the change; do not use the word AI.`;

/** The restyle operation a classification maps to, or null when it is not a restyle. */
export function restyleOperationFor(classification: RestyleClassification) {
  if (!classification.restyle) return null;
  const palette =
    classification.palette === 'custom' && classification.colors
      ? classification.colors
      : classification.palette !== 'custom' && classification.palette !== 'keep'
        ? classification.palette
        : undefined;
  const fontPair = classification.fontPair === 'keep' ? undefined : classification.fontPair;
  const imagery =
    classification.imagery === 'paintings' || classification.imagery === 'none'
      ? classification.imagery
      : undefined;
  if (!palette && !fontPair && !imagery && classification.scope === 'theme') return null;
  return {
    op: 'deck_restyle' as const,
    ...(palette ? { palette } : {}),
    ...(fontPair ? { fontPair } : {}),
    scope: classification.scope,
    ...(imagery ? { imagery } : {}),
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
  const number = `(\\d{1,2}|${words.join('|')})`;
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

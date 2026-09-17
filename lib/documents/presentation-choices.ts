import { z } from 'zod';
import { FONT_PAIR_NAMES, PALETTE_NAMES } from './presentation-compositions';
import { briefChartSchema, briefTableSchema, type PresentationBriefV2 } from './presentation-design';

export const PRESENTATION_CHOICE_TOOL = 'ask_presentation_choices';
export const SOURCE_CHOICES = ['provided', 'mail', 'meetings', 'files', 'web'] as const;
export const VISUAL_CHOICES = [
  'column',
  'bar',
  'line',
  'pie',
  'doughnut',
  'table',
  'metrics',
  'process',
  'comparison',
  'image',
  'typography',
] as const;
export type VisualChoice = (typeof VISUAL_CHOICES)[number];
export const VISUAL_LABELS: Record<VisualChoice, string> = {
  column: 'Column chart',
  bar: 'Bar chart',
  line: 'Line chart',
  pie: 'Pie chart',
  doughnut: 'Doughnut chart',
  table: 'Data table',
  metrics: 'Key numbers',
  process: 'Process',
  comparison: 'Comparison',
  image: 'Image & story',
  typography: 'Statement',
};
export const THEME_DESCRIPTIONS: Record<(typeof PALETTE_NAMES)[number], string> = {
  editorial: 'Warm paper & rust',
  signal: 'Crisp white & blue',
  grove: 'Botanical greens',
  lagoon: 'Airy teal',
  dusk: 'Soft violet',
  rose: 'Warm rose',
  sand: 'Ochre & parchment',
  slate: 'Cool blue-grey',
};
export const FONT_DESCRIPTIONS: Record<(typeof FONT_PAIR_NAMES)[number], string> = {
  serif: 'Fraunces · expressive editorial',
  sans: 'Geist · clean and direct',
  literary: 'Instrument Serif · elegant contrast',
  humanist: 'Manrope · open and friendly',
  grotesk: 'Space Grotesk · geometric',
  mono: 'Geist Mono · technical precision',
};

const text = z.string().trim().max(2000);
export const storyboardSlideSchema = z.object({
  id: z.string().min(1).max(120),
  kind: z.enum(['cover', 'content', 'divider', 'close']),
  title: z.string().min(1).max(120),
  takeaway: z.string().max(400),
  recommended: z.enum(VISUAL_CHOICES),
  alternatives: z.array(z.enum(VISUAL_CHOICES)).max(4).default([]),
  chart: briefChartSchema.optional(),
  table: briefTableSchema.optional(),
  evidence: z.array(z.string().max(300)).max(4).default([]),
});
export type StoryboardSlide = z.infer<typeof storyboardSlideSchema>;
export const presentationChoiceInputSchema = z
  .object({
    presentationId: z
      .string()
      .min(1)
      .max(120)
      .describe('Stable ID for this presentation across all three checkpoints; use a new ID for a new deck.'),
    stage: z.enum(['brief', 'design', 'storyboard']),
    title: z.string().min(1).max(120),
    summary: z.string().max(1000).default(''),
    audience: text.optional(),
    purpose: text.optional(),
    sources: z.array(z.enum(SOURCE_CHOICES)).max(5).optional(),
    contentSlides: z.number().int().min(1).max(24).optional(),
    sectionBreaks: z.number().int().min(0).max(4).optional(),
    theme: z.enum(PALETTE_NAMES).optional(),
    fontPair: z.enum(FONT_PAIR_NAMES).optional(),
    imagery: z.enum(['none', 'provided', 'paintings']).optional(),
    slides: z.array(storyboardSlideSchema).min(3).max(30).optional(),
  })
  .refine((input) => input.stage !== 'storyboard' || Boolean(input.slides?.length), {
    message: 'A storyboard needs the complete proposed slide sequence.',
    path: ['slides'],
  });
export type PresentationChoiceInput = z.infer<typeof presentationChoiceInputSchema>;

export const presentationBriefChoicesSchema = z
  .object({
    audience: text.min(1),
    purpose: text.min(1),
    sources: z.array(z.enum(SOURCE_CHOICES)).min(1).max(5),
    sourceGuidance: text,
    contentSlides: z.number().int().min(1).max(24),
    sectionBreaks: z.number().int().min(0).max(4),
    detail: z.enum(['concise', 'balanced', 'detailed']),
  })
  .refine(
    (value) => value.contentSlides + value.sectionBreaks + 2 <= 30,
    'Choose at most 30 slides including opening, section breaks and close.',
  );
export type PresentationBriefChoices = z.infer<typeof presentationBriefChoicesSchema>;
export const presentationDesignChoicesSchema = z.object({
  theme: z.enum(PALETTE_NAMES),
  fontPair: z.enum(FONT_PAIR_NAMES),
  imagery: z.enum(['none', 'provided', 'paintings']),
  guidance: text,
});
export type PresentationDesignChoices = z.infer<typeof presentationDesignChoicesSchema>;
export const presentationChoiceResultSchema = z.object({
  presentationId: z.string().min(1).max(120),
  stage: z.enum(['brief', 'design', 'storyboard']),
  decision: z.enum(['continue', 'revise', 'cancel']),
  brief: presentationBriefChoicesSchema.optional(),
  design: presentationDesignChoicesSchema.optional(),
  visuals: z
    .array(z.object({ slideId: z.string().min(1).max(120), visual: z.enum(VISUAL_CHOICES) }))
    .max(30)
    .optional(),
  guidance: text.default(''),
  delegateRemaining: z.boolean().default(false),
});
export type PresentationChoiceResult = z.infer<typeof presentationChoiceResultSchema>;

export function tableForStoryboard(slide: StoryboardSlide) {
  if (slide.table) return slide.table;
  if (!slide.chart) return undefined;
  const table = {
    headers: ['Category', ...slide.chart.series.map((series) => series.name)],
    rows: slide.chart.categories.map((category, index) => [
      category,
      ...slide.chart!.series.map(
        (series) => `${series.values[index]}${slide.chart!.unit ? ` ${slide.chart!.unit}` : ''}`,
      ),
    ]),
    source: slide.chart.source,
  };
  const parsed = briefTableSchema.safeParse(table);
  return parsed.success ? parsed.data : undefined;
}

export function visualOptionsForSlide(slide: StoryboardSlide): VisualChoice[] {
  if (slide.kind !== 'content') return ['typography'];
  return [...new Set([slide.recommended, ...slide.alternatives])].filter((kind) => {
    if (kind === 'table') return Boolean(tableForStoryboard(slide));
    if (['column', 'bar', 'line', 'pie', 'doughnut', 'metrics'].includes(kind)) {
      if (!slide.chart) return false;
      if (kind === 'metrics') return slide.chart.series.length === 1 && slide.chart.categories.length <= 4;
      if (kind === 'pie' || kind === 'doughnut')
        return (
          slide.chart.series.length === 1 &&
          slide.chart.series[0].values.every((value) => value >= 0) &&
          slide.chart.series[0].values.some((value) => value > 0)
        );
    }
    return true;
  });
}

export interface PresentationSession {
  presentationId?: string;
  brief?: PresentationBriefChoices;
  design?: PresentationDesignChoices;
  storyboard?: StoryboardSlide[];
  visuals?: NonNullable<PresentationChoiceResult['visuals']>;
  guidance?: string;
  delegate?: boolean;
  cancelled?: boolean;
}

/** Restore confirmed choices from durable tool results, never from model prose. */
export function presentationSessionFromMessages(
  messages: ReadonlyArray<{ role?: string; parts?: unknown[] }>,
): PresentationSession {
  let session: PresentationSession = {};
  for (const message of messages) {
    if (message.role === 'user') {
      const userText = (message.parts ?? [])
        .map((part: any) => (part.type === 'text' ? part.text : ''))
        .join(' ');
      if (
        /\b(?:create|generate|make|build|prepare|design)\b.{0,100}\b(?:presentation|deck|slides)\b/i.test(
          userText,
        )
      )
        session = {};
      if (
        /\b(?:skip (?:the |all )?questions|(?:you |please )?(?:decide|choose) (?:everything|for me)|use your (?:best )?(?:judgment|judgement))\b/i.test(
          userText,
        )
      )
        session.delegate = true;
      continue;
    }
    if (message.role !== 'assistant') continue;
    for (const part of (message.parts ?? []) as any[]) {
      if (
        part.type !== `tool-${PRESENTATION_CHOICE_TOOL}` &&
        !(part.type === 'dynamic-tool' && part.toolName === PRESENTATION_CHOICE_TOOL)
      )
        continue;
      const input = presentationChoiceInputSchema.safeParse(part.input);
      if (!input.success) continue;
      if (input.data.stage === 'brief') session = { presentationId: input.data.presentationId };
      if (session.presentationId !== input.data.presentationId) continue;
      // A newer pending/revised checkpoint invalidates later confirmation.
      if (input.data.stage === 'design') {
        delete session.design;
        delete session.storyboard;
        delete session.visuals;
      }
      if (input.data.stage === 'storyboard') {
        delete session.storyboard;
        delete session.visuals;
      }
      const result = presentationChoiceResultSchema.safeParse(part.output);
      if (
        part.state !== 'output-available' ||
        !result.success ||
        result.data.stage !== input.data.stage ||
        result.data.presentationId !== input.data.presentationId
      )
        continue;
      const value = result.data;
      if (value.decision === 'cancel') {
        session.cancelled = true;
        continue;
      }
      if (value.decision === 'revise') {
        session.guidance = value.guidance;
        continue;
      }
      session.delegate = value.delegateRemaining || session.delegate;
      if (value.stage === 'brief' && value.brief) session.brief = value.brief;
      if (value.stage === 'design' && value.design && session.brief) session.design = value.design;
      if (
        value.stage === 'storyboard' &&
        session.brief &&
        session.design &&
        input.data.slides &&
        value.visuals
      ) {
        const slides = input.data.slides;
        const valid =
          slides.length === session.brief.contentSlides + session.brief.sectionBreaks + 2 &&
          slides[0].kind === 'cover' &&
          slides.at(-1)?.kind === 'close' &&
          slides.filter((slide) => slide.kind === 'content').length === session.brief.contentSlides &&
          slides.filter((slide) => slide.kind === 'divider').length === session.brief.sectionBreaks &&
          new Set(slides.map((slide) => slide.id)).size === slides.length &&
          value.visuals.length === slides.length &&
          new Set(value.visuals.map((entry) => entry.slideId)).size === slides.length &&
          slides.every((slide) =>
            value.visuals!.some(
              (entry) => entry.slideId === slide.id && visualOptionsForSlide(slide).includes(entry.visual),
            ),
          );
        if (valid) {
          session.storyboard = slides;
          session.visuals = value.visuals;
          session.guidance = value.guidance;
        }
      }
    }
  }
  return session;
}

export function nextPresentationCheckpoint(
  session: PresentationSession,
): 'brief' | 'design' | 'storyboard' | 'cancelled' | null {
  if (session.cancelled) return 'cancelled';
  if (session.delegate) return null;
  if (!session.brief) return 'brief';
  if (!session.design) return 'design';
  return session.storyboard && session.visuals ? null : 'storyboard';
}

/** Apply confirmed choices to the researched brief before composition, preserving approved data. */
export function applyPresentationChoices(
  brief: PresentationBriefV2,
  session: PresentationSession,
): PresentationBriefV2 {
  const next = structuredClone(brief);
  if (session.brief) {
    if (brief.slides.length !== session.brief.contentSlides + session.brief.sectionBreaks + 2)
      throw new Error(
        'Match the confirmed content-slide and section-break counts before creating the presentation.',
      );
    next.audience = session.brief.audience.slice(0, 200);
    next.purpose = session.brief.purpose.slice(0, 300);
  }
  if (session.design) {
    next.palette = session.design.theme;
    next.fontPair = session.design.fontPair;
  }
  if (session.storyboard && session.visuals) {
    if (next.slides.length !== session.storyboard.length)
      throw new Error('The presentation must match the confirmed storyboard.');
    next.slides.forEach((slide, index) => {
      const planned = session.storyboard![index];
      const choice = session.visuals!.find((entry) => entry.slideId === planned.id)!.visual;
      slide.title = planned.title;
      if (planned.kind === 'cover' || planned.kind === 'close') slide.role = planned.kind;
      else if (planned.kind === 'divider' || choice === 'typography') slide.role = 'statement';
      else if (choice === 'table') {
        slide.role = 'table';
        slide.table = tableForStoryboard(planned);
      } else if (['column', 'bar', 'line', 'pie', 'doughnut'].includes(choice)) {
        slide.role = 'chart';
        slide.chart = {
          ...planned.chart!,
          type: choice as NonNullable<PresentationBriefV2['slides'][number]['chart']>['type'],
        };
      } else if (choice === 'metrics') {
        slide.role = 'metrics';
        slide.chart = planned.chart;
        slide.items = planned.chart!.categories.slice(0, 4).map((category, i) => ({
          label: `${planned.chart!.series[0].values[i]}${planned.chart!.unit ? ` ${planned.chart!.unit}` : ''}`,
          detail: category,
        }));
      } else slide.role = choice === 'image' ? 'image-right' : (choice as 'process' | 'comparison');
      const provenance = `Confirmed slide: ${planned.title}\nTakeaway: ${planned.takeaway}\nSources: ${planned.evidence.join('; ')}`;
      const notes = [slide.notes, provenance].filter(Boolean).join('\n\n');
      // The durable storyboard already retains these references. Append them
      // when they fit without displacing original notes or breaking preflight.
      if (
        !slide.notes.includes(provenance) &&
        notes.length <= 12000 &&
        JSON.stringify({ ...slide, notes }).length <= 40000
      )
        slide.notes = notes;
    });
  }
  return next;
}

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
// Strict structured-output providers emit null for omitted optional fields.
// Treat only optional nulls as absent; never coerce or discard chart values.
const optional = <T extends z.ZodType>(schema: T) =>
  schema
    .nullable()
    .transform((value) => value ?? undefined)
    .optional();
export const storyboardSlideSchema = z.object({
  id: z.string().min(1).max(120),
  kind: z.enum(['cover', 'content', 'divider', 'close']),
  title: z.string().min(1).max(120),
  takeaway: z.string().max(400),
  recommended: z.enum(VISUAL_CHOICES),
  alternatives: z
    .array(z.enum(VISUAL_CHOICES))
    .max(4)
    .nullish()
    .transform((value) => value ?? []),
  chart: optional(briefChartSchema),
  table: optional(briefTableSchema),
  evidence: z
    .array(z.string().max(300))
    .max(4)
    .nullish()
    .transform((value) => value ?? []),
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
    summary: z
      .string()
      .max(1000)
      .nullish()
      .transform((value) => value ?? ''),
    audience: optional(text),
    purpose: optional(text),
    sources: optional(z.array(z.enum(SOURCE_CHOICES)).max(5)),
    contentSlides: optional(z.number().int().min(1).max(24)),
    sectionBreaks: optional(z.number().int().min(0).max(4)),
    theme: optional(z.enum(PALETTE_NAMES)),
    fontPair: optional(z.enum(FONT_PAIR_NAMES)),
    slides: optional(z.array(storyboardSlideSchema).min(3).max(30)),
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
  // Read old receipts without making imagery a new, mutually exclusive choice.
  imagery: z.enum(['none', 'provided', 'paintings']).optional(),
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

/** Validate before pausing for the user, including the confirmed slide counts. */
export function presentationChoiceSchemaForSession(session?: PresentationSession) {
  const next = session ? nextPresentationCheckpoint(session) : undefined;
  // Encode the next checkpoint in the provider's schema, not only in prose.
  const schema = presentationChoiceInputSchema.safeExtend({
    stage: next && next !== 'cancelled' ? z.literal(next) : presentationChoiceInputSchema.shape.stage,
    presentationId: session?.presentationId
      ? z.literal(session.presentationId)
      : presentationChoiceInputSchema.shape.presentationId,
  });
  return schema.superRefine((input, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (session) {
      const checkpoint = nextPresentationCheckpoint(session);
      if (!checkpoint || checkpoint === 'cancelled')
        issue(
          ['stage'],
          'No presentation questions remain. Honor the saved choices and delegation; stop if cancelled.',
        );
      else if (input.stage !== checkpoint)
        issue(['stage'], `Only ask the unanswered ${checkpoint} checkpoint. Keep all confirmed answers.`);
    }
    if (input.stage !== 'storyboard' || !input.slides) return;
    const slides = input.slides;
    if (slides[0].kind !== 'cover' || slides.at(-1)?.kind !== 'close')
      issue(['slides'], 'Start with the cover and end with the close.');
    if (
      slides.filter((slide) => slide.kind === 'cover').length !== 1 ||
      slides.filter((slide) => slide.kind === 'close').length !== 1
    )
      issue(['slides'], 'Include exactly one cover and one close.');
    if (new Set(slides.map((slide) => slide.id)).size !== slides.length)
      issue(['slides'], 'Give every slide a unique ID.');
    if (
      session?.brief &&
      (slides.filter((slide) => slide.kind === 'content').length !== session.brief.contentSlides ||
        slides.filter((slide) => slide.kind === 'divider').length !== session.brief.sectionBreaks)
    )
      issue(
        ['slides'],
        `Use the confirmed ${session.brief.contentSlides} content slides and ${session.brief.sectionBreaks} section breaks, plus cover and close.`,
      );
    slides.forEach((slide, index) => {
      if (!visualOptionsForSlide(slide).includes(slide.recommended))
        issue(
          ['slides', index, 'recommended'],
          'Choose a supported visual with verified chart/table data, or use typography.',
        );
    });
  });
}

export function presentationChoiceRepair(input: unknown) {
  const parsed = presentationChoiceSchemaForSession().safeParse(input);
  return {
    ok: false,
    status: 'invalid_presentation_choices',
    issues: parsed.success
      ? []
      : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    nextStep:
      'Repair these fields and call ask_presentation_choices again with the same presentationId and checkpoint. Retain all gathered evidence and confirmed brief/theme/font choices. This is validation feedback, not user approval. Do not create the deck yet.',
  };
}

function revisePresentationCheckpoint(
  session: PresentationSession,
  stage: 'brief' | 'design' | 'storyboard',
) {
  if (stage === 'brief') delete session.brief;
  if (stage !== 'storyboard') delete session.design;
  delete session.storyboard;
  delete session.visuals;
  session.delegate = false;
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
      // Continuing construction of this deck must not erase its answers.
      if (
        /\b(?:create|generate|make|build|prepare|design)\b.{0,100}\b(?:presentation|deck|slides)\b/i.test(
          userText,
        ) &&
        (/\b(?:new|another)\s+(?:presentation|deck|slides)\b/i.test(userText) ||
          !/\b(?:this|that|the|same|approved|confirmed)\s+(?:presentation|deck|slides)\b/i.test(userText))
      )
        session = {};
      // Explicit requests to revisit choices are different from model retries.
      if (
        session.presentationId &&
        /^(?:(?:please|actually|can we|can you|could you|i want to|let's)\s+)*(?:change|revise|revisit|redo|reopen|choose different)\b/i.test(
          userText.trim(),
        )
      ) {
        const stage = /\b(?:brief|audience|purpose|sources|slide count|section breaks)\b/i.test(userText)
          ? 'brief'
          : /\b(?:theme|fonts?|colors?|colours?|design choices)\b/i.test(userText)
            ? 'design'
            : /\b(?:storyboard|visual choices|graph choices)\b/i.test(userText)
              ? 'storyboard'
              : null;
        if (stage) {
          revisePresentationCheckpoint(session, stage);
          session.guidance = userText;
        }
      }
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
      if (!session.presentationId && input.data.stage === 'brief')
        session.presentationId = input.data.presentationId;
      const result = presentationChoiceResultSchema.safeParse(part.output);
      if (
        part.state !== 'output-available' ||
        !result.success ||
        result.data.stage !== input.data.stage ||
        result.data.presentationId !== input.data.presentationId
      )
        continue;
      const value = result.data;
      // A model retry/pending card cannot revoke a user's answers. Older runs
      // could repeat brief cards under new IDs; retain their submitted choices
      // and delegation, adopting the ID only when the user actually answered.
      if (value.stage === 'brief') session.presentationId = value.presentationId;
      if (session.presentationId !== value.presentationId) continue;
      if (value.decision === 'cancel') {
        session.cancelled = true;
        continue;
      }
      if (value.decision === 'revise') {
        revisePresentationCheckpoint(session, value.stage);
        session.guidance = value.guidance;
        continue;
      }
      session.delegate = value.delegateRemaining || session.delegate;
      if (value.stage === 'brief' && value.brief) {
        if (session.brief && JSON.stringify(session.brief) !== JSON.stringify(value.brief)) {
          delete session.storyboard;
          delete session.visuals;
        }
        session.brief = value.brief;
      }
      if (value.stage === 'design' && value.design && session.brief) {
        if (session.design && JSON.stringify(session.design) !== JSON.stringify(value.design)) {
          delete session.storyboard;
          delete session.visuals;
        }
        session.design = value.design;
      }
      if (
        value.stage === 'storyboard' &&
        session.brief &&
        session.design &&
        input.data.slides &&
        value.visuals
      ) {
        const slides = input.data.slides;
        // Older clients allowed confirmation of a complete storyboard whose
        // counts differed from the initial brief. Honor the user's latest
        // explicit selection instead of repeatedly discarding that receipt.
        // New requests are checked against the brief before the picker opens.
        const confirmedBrief = presentationBriefChoicesSchema.safeParse({
          ...session.brief,
          contentSlides: slides.filter((slide) => slide.kind === 'content').length,
          sectionBreaks: slides.filter((slide) => slide.kind === 'divider').length,
        });
        const valid =
          confirmedBrief.success &&
          presentationChoiceSchemaForSession().safeParse(input.data).success &&
          value.visuals.length === slides.length &&
          new Set(value.visuals.map((entry) => entry.slideId)).size === slides.length &&
          slides.every((slide) =>
            value.visuals!.some(
              (entry) => entry.slideId === slide.id && visualOptionsForSlide(slide).includes(entry.visual),
            ),
          );
        if (valid && confirmedBrief.success) {
          session.brief = confirmedBrief.data;
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
  // Models sometimes omit the opening/close or section breaks when translating
  // the approved outline. Fill only unambiguous structural slides from the exact
  // approved copy; missing research/content still requires model remediation.
  if (session.storyboard && next.slides.length !== session.storyboard.length) {
    const drafts = new Map(next.slides.map((slide) => [slide.title, slide]));
    const titles = new Set(session.storyboard.map((slide) => slide.title));
    if (
      drafts.size === next.slides.length &&
      titles.size === session.storyboard.length &&
      next.slides.every((slide) => titles.has(slide.title)) &&
      session.storyboard.every((slide) => drafts.has(slide.title) || slide.kind !== 'content')
    ) {
      next.slides = session.storyboard.map(
        (planned) =>
          drafts.get(planned.title) ?? {
            role: planned.kind === 'cover' || planned.kind === 'close' ? planned.kind : 'statement',
            title: planned.title,
            body: planned.takeaway,
            kicker: '',
            items: [],
            notes: '',
            visualRole: 'Confirmed narrative transition',
          },
      );
    }
  }
  if (session.brief) {
    if (next.slides.length !== session.brief.contentSlides + session.brief.sectionBreaks + 2)
      throw new Error(
        `The confirmed counts require ${session.brief.contentSlides + session.brief.sectionBreaks + 2} slides (${session.brief.contentSlides} content, ${session.brief.sectionBreaks} section breaks, opening and close); received ${next.slides.length}. Repair the draft to match the confirmed storyboard. Keep the existing user confirmation; do not ask again.`,
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

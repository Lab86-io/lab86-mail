import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { liftToolsForAgent } from '../lib/ai/loop';
import { createHitlAutoContinueGuard, isHitlToolName } from '../lib/albatross/teach-ui';
import { checkDeck, contrastRatio, textFits } from '../lib/documents/deck-quality';
import { deckExportFace, deckFontStack } from '../lib/documents/deck-versions';
import {
  applyPresentationChoices,
  nextPresentationCheckpoint,
  type PresentationSession,
  presentationChoiceInputSchema,
  presentationChoiceRepair,
  presentationChoiceResultSchema,
  presentationChoiceSchemaForSession,
  presentationSessionFromMessages,
  type StoryboardSlide,
  tableForStoryboard,
  visualOptionsForSlide,
} from '../lib/documents/presentation-choices';
import {
  buildDeckTheme,
  FONT_PAIR_NAMES,
  fontPairOf,
  PALETTE_NAMES,
} from '../lib/documents/presentation-compositions';
import {
  composePresentationV2,
  restyleClassificationSchema,
  restyleOperationFor,
} from '../lib/documents/presentation-design';
import { compactMessage } from '../lib/store/chat-sessions';
import { __setDocumentToolDepsForTest } from '../lib/tools/documents';
import { presentationPlan } from '../lib/tools/presentations';
import { harborBrief, retroBrief, VALLEY } from './fixtures/presentation-briefs';
import { runTool } from './tools/harness';

const brief = {
  audience: 'Leadership',
  purpose: 'Choose a direction',
  sources: ['provided'] as const,
  sourceGuidance: '',
  contentSlides: 1,
  sectionBreaks: 0,
  detail: 'balanced' as const,
};
const design = {
  theme: 'lagoon' as const,
  fontPair: 'humanist' as const,
  imagery: 'none' as const,
  guidance: '',
};
const chart = {
  type: 'column' as const,
  categories: ['A', 'B'],
  series: [{ name: 'Count', values: [4, 8] }],
  unit: 'users',
  source: 'Verified source',
};
const slides: StoryboardSlide[] = [
  {
    id: 'open',
    kind: 'cover',
    title: 'Our direction',
    takeaway: 'An evidence-based story',
    recommended: 'typography',
    alternatives: [],
    evidence: [],
  },
  {
    id: 'data',
    kind: 'content',
    title: 'B leads A',
    takeaway: 'B has twice as many users',
    recommended: 'column',
    alternatives: ['bar', 'line', 'table', 'metrics'],
    chart,
    evidence: ['Verified source'],
  },
  {
    id: 'close',
    kind: 'close',
    title: 'Next steps',
    takeaway: 'Choose B',
    recommended: 'typography',
    alternatives: [],
    evidence: [],
  },
];
const visuals = slides.map((slide) => ({ slideId: slide.id, visual: slide.recommended }));
function part(stage: 'brief' | 'design' | 'storyboard', output: any = {}, input: any = {}) {
  return {
    type: 'tool-ask_presentation_choices',
    toolCallId: stage,
    state: 'output-available',
    input: {
      presentationId: 'deck',
      stage,
      title: 'Direction',
      ...(stage === 'storyboard' ? { slides } : {}),
      ...input,
    },
    output: {
      presentationId: 'deck',
      stage,
      decision: 'continue',
      ...(stage === 'brief' ? { brief } : stage === 'design' ? { design } : { visuals }),
      ...output,
    },
  };
}
function messages(parts = [part('brief'), part('design'), part('storyboard')]) {
  return [{ role: 'assistant', parts }];
}
function ready(): PresentationSession {
  return presentationSessionFromMessages(messages());
}
afterEach(() => __setDocumentToolDepsForTest());

describe('guided presentation preferences', () => {
  test('new design receipts omit imagery and allow artwork, owned images and approved data together', async () => {
    const { imagery: _legacyImagery, ...currentDesign } = design;
    const input = presentationChoiceInputSchema.parse({ ...part('design').input, imagery: 'none' });
    expect(input).not.toHaveProperty('imagery');
    const session = presentationSessionFromMessages(
      messages([part('brief'), part('design', { design: currentDesign }), part('storyboard')]),
    );
    expect(nextPresentationCheckpoint(session)).toBeNull();
    expect(session.design).toEqual(currentDesign);
    const uploads = mock(async () => ({ assets: [VALLEY], notes: [] }));
    const proposal = mock(async (input: any) => {
      expect(input.assets).toEqual([VALLEY]);
      expect(input.artwork).toBe('auto');
      expect(input.presentation.slides[1].chart).toEqual(chart);
      throw new Error('Mixed visuals reached composition');
    });
    __setDocumentToolDepsForTest({ assetsFromUploads: uploads, composeDocumentPresentation: proposal });
    const draft = harborBrief();
    draft.slides = Array.from({ length: 3 }, () => structuredClone(draft.slides[0]));
    await expect(
      runTool(
        () =>
          liftToolsForAgent(undefined, 'UTC', session).document_create.execute({
            kind: 'deck',
            title: 'Direction',
            presentation: draft,
            artwork: 'auto',
            imageUploadIds: ['owned-upload'],
          }),
        {},
      ),
    ).rejects.toThrow('Mixed visuals reached composition');
    expect(uploads).toHaveBeenCalledTimes(1);
    expect(proposal).toHaveBeenCalledTimes(1);
  });
  test('planning recovery survives saved history and oversized plans are never labeled successful', () => {
    const output = {
      ok: false,
      readyToBuild: false,
      recovery: {
        completedSlides: Array.from({ length: 15 }, (_, index) => ({
          slideNumber: index + 1,
          slide: { title: `Slide ${index}`, purpose: 'Research notes '.repeat(80) },
        })),
        pendingSlideNumbers: [16, 17],
      },
      nextStep: 'Continue from retained evidence.',
    };
    const save = (output: unknown) =>
      compactMessage({
        role: 'assistant',
        parts: [
          {
            type: 'tool-presentation_plan',
            toolCallId: 'plan',
            state: 'output-available',
            input: { evidence: ['Retained source'] },
            output,
          },
        ],
      }).parts[0];
    expect(JSON.stringify(output).length).toBeGreaterThan(4000);
    expect(save(output).output).toEqual(output);
    const large = save({ ok: true, plan: 'x'.repeat(128001) });
    expect(large.output).toMatchObject({ ok: false, readyToBuild: false, outputOmitted: true });
    expect(large.input.evidence).toEqual(['Retained source']);
    const unicode = { ok: true, plan: '界'.repeat(50000) };
    expect(JSON.stringify(unicode).length).toBeLessThan(128000);
    expect(save(unicode).output).toMatchObject({ ok: false, readyToBuild: false, outputOmitted: true });
  });
  test('optional provider nulls preserve data and restore confirmed storyboard choices', () => {
    const input = {
      ...part('storyboard').input,
      theme: null,
      fontPair: null,
      audience: null,
      purpose: null,
      sources: null,
      contentSlides: null,
      sectionBreaks: null,
      imagery: null,
      slides: slides.map((slide) => ({ ...slide, chart: slide.chart ?? null, table: null })),
    };
    expect(
      presentationChoiceSchemaForSession({
        presentationId: 'deck',
        brief: { ...brief, sources: ['provided'] },
        design,
      }).safeParse(input).success,
    ).toBe(true);
    const restored = presentationSessionFromMessages(
      messages([part('brief'), part('design'), part('storyboard', {}, input)]),
    );
    expect(restored.storyboard?.[1].chart?.series[0].values).toEqual([4, 8]);
    expect(nextPresentationCheckpoint(restored)).toBeNull();
    expect(
      presentationChoiceInputSchema.safeParse({
        ...input,
        slides: input.slides.map((slide: any) =>
          slide.chart
            ? { ...slide, chart: { ...slide.chart, series: [{ name: 'Count', values: [null, 8] }] } }
            : slide,
        ),
      }).success,
    ).toBe(false);
  });
  test('server validation catches unreviewable sequences, unsupported visuals and mismatched confirmed counts', () => {
    const schema = presentationChoiceSchemaForSession({
      presentationId: 'deck',
      brief: { ...brief, sources: ['provided'] },
      design,
    });
    for (const input of [
      { ...part('storyboard').input, presentationId: 'wrong' },
      { ...part('storyboard').input, slides: [...slides].reverse() },
      { ...part('storyboard').input, slides: [slides[0], slides[0], slides[2]] },
      {
        ...part('storyboard').input,
        slides: [slides[0], slides[1], { ...slides[1], id: 'extra' }, slides[2]],
      },
      { ...part('storyboard').input, slides: slides.map((slide) => ({ ...slide, chart: null })) },
    ])
      expect(schema.safeParse(input).success).toBe(false);
    const feedback = presentationChoiceRepair({
      ...part('storyboard').input,
      slides: [{ ...slides[0], takeaway: 'x'.repeat(401) }, ...slides.slice(1)],
    });
    expect(feedback.issues.join(' ')).toContain('slides.0.takeaway');
    expect(feedback.nextStep).toContain('not user approval');
    expect(feedback).not.toHaveProperty('decision');
    expect(presentationChoiceRepair(part('brief').input).issues).toEqual([]);
  });
  test('monospace display titles are measured at their actual width and retain the display font slot', () => {
    const model = composePresentationV2({ ...retroBrief(), fontPair: 'mono' });
    const title = model.slides[4].elements.find(
      (element) => element.type === 'text' && element.role === 'title',
    );
    expect(title?.type).toBe('text');
    if (!title || title.type !== 'text') throw new Error('Missing comparison title');
    expect(title.text).toBe('What we planned against what we got');
    expect(title.font).not.toBe('mono');
    expect(title.fontSize).toBeLessThan(38);
    expect(textFits(title, model.theme)).toBe(true);
    expect(textFits({ ...title, fontSize: 38 }, model.theme)).toBe(false);
    expect(checkDeck(model).ok).toBe(true);
  });
  test('requires complete storyboard inputs and bounded responses', () => {
    expect(
      presentationChoiceInputSchema.safeParse({ presentationId: 'd', title: 'Title', stage: 'storyboard' })
        .success,
    ).toBe(false);
    expect(presentationChoiceInputSchema.safeParse(part('brief').input).success).toBe(true);
    expect(
      presentationChoiceResultSchema.safeParse({
        ...part('brief').output,
        brief: { ...brief, contentSlides: 25 },
      }).success,
    ).toBe(false);
    expect(
      presentationChoiceResultSchema.safeParse({ ...part('brief').output, brief: { ...brief, sources: [] } })
        .success,
    ).toBe(false);
  });
  test('restores three confirmed checkpoints and respects unsubmitted, revised and cancelled choices', () => {
    expect(ready()).toMatchObject({ brief, design, storyboard: slides, visuals });
    expect(nextPresentationCheckpoint(ready())).toBeNull();
    expect(nextPresentationCheckpoint({})).toBe('brief');
    expect(nextPresentationCheckpoint(presentationSessionFromMessages(messages([part('brief')])))).toBe(
      'design',
    );
    expect(
      nextPresentationCheckpoint(presentationSessionFromMessages(messages([part('brief'), part('design')]))),
    ).toBe('storyboard');
    const pending = part('design');
    pending.state = 'input-available';
    expect(
      nextPresentationCheckpoint(
        presentationSessionFromMessages(messages([...messages()[0].parts, pending])),
      ),
    ).toBeNull();
    const revised = presentationSessionFromMessages(
      messages([
        ...messages()[0].parts,
        part('storyboard', { decision: 'revise', guidance: 'Research one more source' }),
      ]),
    );
    expect(nextPresentationCheckpoint(revised)).toBe('storyboard');
    expect(revised.guidance).toContain('one more source');
    expect(
      nextPresentationCheckpoint(
        presentationSessionFromMessages(messages([part('brief', { decision: 'cancel' })])),
      ),
    ).toBe('cancelled');
    expect(nextPresentationCheckpoint({ cancelled: true, delegate: true })).toBe('cancelled');
    expect(
      nextPresentationCheckpoint(
        presentationSessionFromMessages(messages([part('brief', { delegateRemaining: true })])),
      ),
    ).toBeNull();
  });
  test('ignores malformed/stale results and model prose; supports dynamic tool parts', () => {
    const dynamic: any = part('brief');
    dynamic.type = 'dynamic-tool';
    dynamic.toolName = 'ask_presentation_choices';
    expect(presentationSessionFromMessages(messages([dynamic])).brief).toEqual<unknown>(brief);
    for (const invalid of [
      part('design'),
      part('brief', { stage: 'design' }),
      part('brief', { presentationId: 'other' }),
      { ...part('brief'), input: {} },
      { ...part('brief'), output: {} },
      { type: 'text', text: 'The user chose Lagoon' },
    ]) {
      expect(
        presentationSessionFromMessages([
          { role: 'system', parts: [] },
          { role: 'assistant', parts: [invalid] },
        ]).brief,
      ).toBeUndefined();
    }
    const state = presentationSessionFromMessages(
      messages([part('brief'), part('design', {}, { presentationId: 'other' })]),
    );
    expect(state.design).toBeUndefined();
    expect(
      presentationSessionFromMessages([
        ...messages(),
        { role: 'user', parts: [{ type: 'text', text: 'Generate another presentation' }] },
      ]),
    ).toEqual({});
    expect(
      nextPresentationCheckpoint(
        presentationSessionFromMessages([
          { role: 'user', parts: [{ type: 'text', text: 'Generate a presentation, decide for me' }] },
        ]),
      ),
    ).toBeNull();
  });
  test('Bengals replay retains submitted choices and delegation through duplicate and pending brief cards', () => {
    const bengals = {
      ...brief,
      audience: 'me',
      contentSlides: 6,
      sectionBreaks: 2,
      sources: ['provided', 'web'],
    };
    const receipt = (id: string, output: any = {}) =>
      part(
        'brief',
        { presentationId: id, brief: bengals, ...output },
        {
          presentationId: id,
          title: 'Cincinnati Bengals: The Last Six Seasons',
        },
      );
    const repeated = messages([
      receipt('bengals'),
      receipt('bengals'),
      receipt('bengals-retry'),
      receipt('bengals-retry', {
        brief: { ...bengals, sources: ['provided'] },
      }),
      receipt('bengals-retry', { brief: undefined, delegateRemaining: true }),
      receipt('bengals-again'),
      receipt('bengals-again'),
      { ...receipt('invented-id'), state: 'input-available' },
      { ...receipt('invented-id'), state: 'output-error', output: undefined },
    ]);
    const restored = presentationSessionFromMessages(repeated.map(compactMessage));
    expect(restored).toMatchObject({
      presentationId: 'bengals-again',
      brief: bengals,
      delegate: true,
    });
    expect(nextPresentationCheckpoint(restored)).toBeNull();
    expect(
      presentationChoiceSchemaForSession(restored).safeParse(receipt('bengals-again').input).success,
    ).toBe(false);
  });
  test('pending and invalid retries cannot erase confirmed checkpoints or delegation', () => {
    for (const stage of ['brief', 'design', 'storyboard'] as const) {
      for (const retry of [
        { ...part(stage), state: 'input-available' },
        { ...part(stage), output: {} },
        part(stage),
      ]) {
        const restored = presentationSessionFromMessages(messages([...messages()[0].parts, retry]));
        expect(restored).toEqual(ready());
      }
    }
    const delegated = presentationSessionFromMessages([
      {
        role: 'user',
        parts: [{ type: 'text', text: 'Generate a presentation, decide for me' }],
      },
      ...messages([{ ...part('brief'), state: 'input-available' }]),
    ]);
    expect(delegated.delegate).toBe(true);
    expect(nextPresentationCheckpoint(delegated)).toBeNull();
  });
  test('only the next unanswered stage and the saved ID can be requested', () => {
    const state = presentationSessionFromMessages(messages([part('brief')]));
    const schema = presentationChoiceSchemaForSession(state);
    expect(schema.safeParse(part('design').input).success).toBe(true);
    for (const input of [
      part('brief').input,
      part('storyboard').input,
      part('design', {}, { presentationId: 'new' }).input,
    ])
      expect(schema.safeParse(input).success).toBe(false);
    // Runtime validation still honors a later delegation/cancellation.
    state.delegate = true;
    expect(schema.safeParse(part('design').input).success).toBe(false);
    state.delegate = false;
    state.cancelled = true;
    expect(schema.safeParse(part('design').input).success).toBe(false);
    expect(presentationChoiceSchemaForSession(ready()).safeParse(part('storyboard').input).success).toBe(
      false,
    );
    const initial: PresentationSession = {};
    const initialSchema = presentationChoiceSchemaForSession(initial);
    initial.brief = { ...brief, sources: ['provided'] };
    expect(initialSchema.safeParse(part('brief').input).success).toBe(false);
  });
  test('actual user changes invalidate affected confirmations while simple continuation retains them', () => {
    const user = (text: string) => ({
      role: 'user',
      parts: [{ type: 'text', text }],
    });
    for (const text of [
      'Build the presentation now',
      'Generate this deck',
      'Continue',
      'Change the title',
      "Don't change the theme",
    ])
      expect(presentationSessionFromMessages([...messages(), user(text)])).toEqual(ready());
    for (const [text, stage] of [
      ['Revisit the brief', 'brief'],
      ['Change the theme', 'design'],
      ['Revise the storyboard', 'storyboard'],
    ]) {
      const session = presentationSessionFromMessages([...messages(), user(text)]);
      expect(nextPresentationCheckpoint(session)).toBe<unknown>(stage);
      expect(session.guidance).toBe(text);
      expect(session.storyboard).toBeUndefined();
    }
    for (const stage of ['brief', 'design', 'storyboard'] as const) {
      const session = presentationSessionFromMessages(
        messages([...messages()[0].parts, part(stage, { decision: 'revise', guidance: 'Please revise' })]),
      );
      expect(nextPresentationCheckpoint(session)).toBe(stage);
      expect(session.delegate).toBe(false);
    }
    for (const text of ['Generate another presentation', 'Create a presentation about another team'])
      expect(presentationSessionFromMessages([...messages(), user(text)])).toEqual({});
    const changedBrief = presentationSessionFromMessages(
      messages([...messages()[0].parts, part('brief', { brief: { ...brief, contentSlides: 6 } })]),
    );
    expect(changedBrief.design).toEqual(design);
    expect(nextPresentationCheckpoint(changedBrief)).toBe('storyboard');
    const changedDesign = presentationSessionFromMessages(
      messages([...messages()[0].parts, part('design', { design: { ...design, theme: 'rose' } })]),
    );
    expect(changedDesign.design?.theme).toBe('rose');
    expect(nextPresentationCheckpoint(changedDesign)).toBe('storyboard');
  });
  test('rejects mismatched counts, duplicates, unsupported visuals and incomplete sequences', () => {
    for (const bad of [
      part('storyboard', { visuals: [] }),
      part('storyboard', { visuals: [visuals[0], visuals[0], visuals[2]] }),
      part('storyboard', { visuals: [{ slideId: 'open', visual: 'bar' }, ...visuals.slice(1)] }),
      part('storyboard', {}, { slides: slides.map((slide) => ({ ...slide, kind: 'content' })) }),
      part('storyboard', {}, { slides: [slides[0], slides[1], slides[1], slides[2]] }),
      part('storyboard', {}, { slides: slides.map((slide) => ({ ...slide, id: 'same' })) }),
    ])
      expect(
        nextPresentationCheckpoint(
          presentationSessionFromMessages(messages([part('brief'), part('design'), bad])),
        ),
      ).toBe('storyboard');
  });
  test('a complete older storyboard confirmation is authoritative over an earlier slide count', () => {
    const state = presentationSessionFromMessages(
      messages([
        part('brief', { brief: { ...brief, contentSlides: 5, sectionBreaks: 2 } }),
        part('design'),
        part('storyboard'),
      ]),
    );
    expect(state.brief).toMatchObject({
      contentSlides: 1,
      sectionBreaks: 0,
      audience: brief.audience,
      sources: brief.sources,
    });
    expect(state.storyboard).toEqual(slides);
    expect(state.visuals).toEqual(visuals);
    expect(nextPresentationCheckpoint(state)).toBeNull();
    // A pending/revised outline never overrides the brief or gains approval.
    for (const pending of [
      { ...part('storyboard'), state: 'input-available', output: undefined },
      part('storyboard', { decision: 'revise' }),
    ]) {
      const state = presentationSessionFromMessages(
        messages([
          part('brief', { brief: { ...brief, contentSlides: 5, sectionBreaks: 2 } }),
          part('design'),
          pending,
        ]),
      );
      expect(state.brief?.contentSlides).toBe(5);
      expect(nextPresentationCheckpoint(state)).toBe('storyboard');
    }
  });
  test('missing structural slides use approved copy, while missing researched content gets targeted repair', async () => {
    const state = ready();
    const draft = harborBrief();
    draft.slides = [
      {
        ...draft.slides[0],
        title: slides[1].title,
        role: 'chart',
        chart,
        notes: 'Original research',
        items: [],
      },
    ];
    const aligned = applyPresentationChoices(draft, state);
    expect(aligned.slides.map((slide) => slide.title)).toEqual(slides.map((slide) => slide.title));
    expect(aligned.slides[0].body).toBe(slides[0].takeaway);
    expect(aligned.slides[1].notes).toContain('Original research');
    expect(aligned.slides[1].chart).toEqual(chart);
    expect(aligned.slides[2].body).toBe(slides[2].takeaway);
    const tools = liftToolsForAgent(undefined, 'UTC', state);
    const result = await tools.document_create.execute({
      kind: 'deck',
      title: 'Research',
      presentation: { ...draft, slides: [{ ...draft.slides[0], title: 'Missing content' }] },
    });
    expect(result).toMatchObject({
      ok: false,
      status: 'presentation_content_needs_repair',
      confirmedStoryboard: slides,
      confirmedVisuals: visuals,
    });
    expect(result.message).toContain('received 1');
    expect(result.nextStep).toContain('do not ask');
    expect(nextPresentationCheckpoint(state)).toBeNull();
  });
  test('preserves long confirmed answers across persistence and continuation', () => {
    const long = {
      ...brief,
      audience: 'A'.repeat(2000),
      purpose: 'P'.repeat(2000),
      sourceGuidance: 'S'.repeat(2000),
    };
    const saved = compactMessage(messages([part('brief', { brief: long })])[0]);
    expect(presentationSessionFromMessages([saved]).brief).toEqual<unknown>(long);
    const pending = { ...part('brief'), state: 'input-available', output: undefined };
    expect(compactMessage(messages([pending])[0]).parts[0].state).toBe('input-available');
    expect(isHitlToolName('ask_presentation_choices')).toBe(true);
    const huge = compactMessage(messages([part('brief', { guidance: 'x'.repeat(40000) })])[0]);
    expect(huge.parts[0].output.outputOmitted).toBe(true);
  });
  test('offers only representations supported by the actual data', () => {
    expect(tableForStoryboard(slides[0])).toBeUndefined();
    const table = tableForStoryboard(slides[1])!;
    expect(table.rows).toEqual([
      ['A', '4 users'],
      ['B', '8 users'],
    ]);
    expect(tableForStoryboard({ ...slides[1], table })).toEqual(table);
    expect(visualOptionsForSlide(slides[0])).toEqual(['typography']);
    expect(visualOptionsForSlide(slides[1])).toEqual(['column', 'bar', 'line', 'table', 'metrics']);
    expect(visualOptionsForSlide({ ...slides[1], chart: undefined })).toEqual([]);
    const pie = { ...slides[1], recommended: 'pie' as const, alternatives: ['doughnut', 'pie'] as const };
    expect(visualOptionsForSlide({ ...pie, alternatives: [...pie.alternatives] })).toEqual([
      'pie',
      'doughnut',
    ]);
    for (const values of [
      [-1, 2],
      [0, 0],
    ])
      expect(
        visualOptionsForSlide({
          ...pie,
          alternatives: [],
          chart: { ...chart, series: [{ name: 'Count', values }] },
        }),
      ).toEqual([]);
    expect(
      visualOptionsForSlide({
        ...slides[1],
        recommended: 'metrics',
        alternatives: ['comparison'],
        chart: { ...chart, series: [...chart.series, ...chart.series] },
      }),
    ).toEqual(['comparison']);
    expect(
      tableForStoryboard({
        ...slides[1],
        chart: {
          ...chart,
          categories: Array(8).fill('Row'),
          series: [{ name: 'Count', values: Array(8).fill(1) }],
        },
      }),
    ).toBeUndefined();
    expect(tableForStoryboard({ ...slides[1], chart: { ...chart, unit: undefined } })?.rows[0]).toEqual([
      'A',
      '4',
    ]);
  });
  test('enforces chosen fonts, colors, count, order, titles and actual chart/table values', () => {
    const draft = harborBrief();
    draft.slides = Array.from({ length: 3 }, () => structuredClone(draft.slides[0]));
    const state = ready();
    for (const visual of [
      'bar',
      'table',
      'metrics',
      'typography',
      'process',
      'comparison',
      'image',
    ] as const) {
      state.visuals![1].visual = visual;
      const applied = applyPresentationChoices(draft, state);
      expect(applied.palette).toBe('lagoon');
      expect(applied.fontPair).toBe('humanist');
      expect(applied.audience).toBe('Leadership');
      expect(applied.slides.map((slide) => slide.title)).toEqual(slides.map((slide) => slide.title));
      expect(applied.slides[0].role).toBe('cover');
      expect(applied.slides[2].role).toBe('close');
      expect(applied.slides[1].notes).toContain('Verified source');
      if (visual === 'bar') expect(applied.slides[1].chart).toEqual({ ...chart, type: 'bar' });
      if (visual === 'table') expect(applied.slides[1].table).toEqual(tableForStoryboard(slides[1]));
      if (visual === 'metrics') expect(applied.slides[1].items[0]).toEqual({ label: '4 users', detail: 'A' });
    }
    expect(draft.palette).not.toBe('lagoon');
    expect(applyPresentationChoices(draft, {})).toEqual(draft);
    expect(() => applyPresentationChoices({ ...draft, slides: [] }, state)).toThrow('counts');
    expect(() => applyPresentationChoices({ ...draft, slides: [] }, { storyboard: slides, visuals })).toThrow(
      'storyboard',
    );
  });
  test('all theme/font pairs compose readable slides and map to supported export fonts', () => {
    for (const palette of PALETTE_NAMES)
      for (const fontPair of FONT_PAIR_NAMES) {
        const theme = buildDeckTheme(palette, fontPair);
        expect(fontPairOf(theme)).toBe(fontPair);
        expect(contrastRatio(theme.colors.ink, theme.colors.background)).toBeGreaterThan(4.5);
        expect(contrastRatio(theme.colors.accentInk, theme.colors.accent)).toBeGreaterThan(4.5);
        expect(deckFontStack(theme, 'display')).toContain(theme.fonts.display.family);
        expect(deckExportFace(theme, 'display')).toBeTruthy();
        const deck = composePresentationV2({ ...harborBrief(), palette, fontPair });
        expect(checkDeck(deck).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
        const classification = restyleClassificationSchema.parse({
          restyle: true,
          palette,
          fontPair,
          scope: 'theme',
          summary: 'Use this style',
        });
        expect(restyleOperationFor(classification)).toMatchObject({ palette, fontPair });
      }
  });
  test('the agent pauses deck writes, allows explicit delegation, and exposes a client-side tool', async () => {
    const state: PresentationSession = {};
    const tools = liftToolsForAgent(undefined, 'UTC', state);
    expect(tools.ask_presentation_choices.execute).toBeUndefined();
    expect(await tools.document_create.execute({ kind: 'deck', title: 'Presentation' })).toMatchObject({
      stage: 'brief',
      ok: false,
    });
    state.cancelled = true;
    expect(await tools.document_create.execute({ kind: 'deck' })).toMatchObject({ stage: 'cancelled' });
    delete state.cancelled;
    Object.assign(state, ready());
    expect(await tools.document_create.execute({ kind: 'deck' })).toMatchObject({
      status: 'needs_presentation_brief',
    });
    await tools.ask_presentation_choices.onInputAvailable({
      input: part('design').input,
    });
    expect(nextPresentationCheckpoint(state)).toBeNull();
    expect(state).toEqual(ready());
    await tools.ask_presentation_choices.onInputAvailable({
      input: part('brief').input,
    });
    expect(nextPresentationCheckpoint(state)).toBeNull();
    const proposal = mock(async (input: any) => {
      throw new Error(
        `Reached generation: ${input.presentation.palette}/${input.presentation.fontPair}/${input.artwork}`,
      );
    });
    __setDocumentToolDepsForTest({ composeDocumentPresentation: proposal });
    const draft = harborBrief();
    draft.slides = Array.from({ length: 3 }, () => structuredClone(draft.slides[0]));
    await expect(
      runTool(
        () =>
          liftToolsForAgent(undefined, 'UTC', ready()).document_create.execute({
            kind: 'deck',
            title: 'Direction',
            presentation: draft,
          }),
        {},
      ),
    ).rejects.toThrow('Reached generation: lagoon/humanist/none');
    expect(proposal).toHaveBeenCalledTimes(1);
  });
  test('confirmed research scope and long design guidance reach the planner; workbooks remain available', async () => {
    const handler = spyOn(presentationPlan, 'handler').mockImplementation(async (args) => {
      expect(args.audience).toHaveLength(2000);
      expect(args.slideCount).toBe(3);
      expect(args.instruction).toContain('Only this quarter');
      expect(args.instruction).toContain('lagoon');
      return {
        ok: true,
        readyToBuild: false,
        issues: ['Retrieve the remaining source'],
        nextStep: 'Read it',
      };
    });
    try {
      const session = ready();
      session.brief!.audience = 'A'.repeat(2000);
      session.brief!.sourceGuidance = 'Only this quarter';
      await runTool(
        () =>
          liftToolsForAgent(undefined, 'UTC', session).presentation_plan.execute({
            instruction: 'I'.repeat(20000),
            evidence: [],
          }),
        {},
      );
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      handler.mockRestore();
    }
    const create = mock(async () => {
      throw new Error('Workbook creation reached');
    });
    __setDocumentToolDepsForTest({ createDocument: create });
    await expect(
      runTool(
        () =>
          liftToolsForAgent(undefined, 'UTC', {}).document_create.execute({
            kind: 'sheet',
            title: 'Evidence calculations',
          }),
        {},
      ),
    ).rejects.toThrow('Workbook creation reached');
    expect(create).toHaveBeenCalledTimes(1);
    const tools = liftToolsForAgent(undefined, 'UTC', { delegate: true });
    await expect(
      runTool(() => tools.document_create.execute({ kind: 'deck', title: 'Delegated' }), {}),
    ).rejects.toThrow('Workbook creation reached');
  });
  test('one submitted checkpoint triggers one continuation, never a pending or restored duplicate', () => {
    const guard = createHitlAutoContinueGuard();
    expect(guard(messages([{ ...part('brief'), state: 'input-available', output: undefined }]))).toBe(false);
    expect(guard(messages([part('brief')]))).toBe(true);
    expect(guard(messages([part('brief')]))).toBe(false);
    expect(guard(messages([part('design')]))).toBe(true);
  });
  test('approved references never overflow existing notes or repeat on repair', () => {
    const draft = harborBrief();
    draft.slides = Array.from({ length: 3 }, () => ({
      ...structuredClone(draft.slides[0]),
      notes: 'N'.repeat(12000),
    }));
    const applied = applyPresentationChoices(draft, ready());
    expect(applied.slides[0].notes).toHaveLength(12000);
    draft.slides[0].notes = '';
    const once = applyPresentationChoices(draft, ready());
    expect(applyPresentationChoices(once, ready()).slides[0].notes).toEqual(once.slides[0].notes);
  });
});

import { describe, expect, mock, test } from 'bun:test';
import { agentStepLimit, liftToolsForAgent } from '../lib/ai/loop';
import {
  type PresentationPlan,
  planPresentation,
  presentationOutlineSchema,
  presentationPlanningRecoverySchema,
  presentationPlanSchema,
} from '../lib/documents/presentation-plan';
import { getTool } from '../lib/tools';

const plan = (): PresentationPlan => ({
  narrative: 'Delivery evidence precedes the decision.',
  design: {
    direction: 'Editorial, concise and clear.',
    palette: 'editorial',
    fontPair: 'serif',
    graphics: 'Native charts and exact tables; no decorative paintings.',
  },
  slides: [
    {
      title: 'Packages delivered',
      takeaway: '152 packages remain blocked.',
      purpose: 'Explain the delivery decision.',
      evidenceIds: ['report'],
      visual: 'chart',
      visualRationale: 'Compare completed and blocked packages.',
      dataRequirements: 'Counts by delivery state.',
      calculations: 'Aggregate the source rows by state using a workbook pivot.',
      toolSteps: [
        { tool: 'spreadsheet_capabilities', task: 'Read pivot and chart command schemas.' },
        { tool: 'document_create', task: 'Create the supporting calculation workbook.' },
        { tool: 'document_edit', task: 'Enter source rows and calculate the totals by state.' },
        { tool: 'document_get', task: 'Verify calculated totals before placing the chart.' },
      ],
      missingEvidence: [],
      layout: 'One main comparison chart, one takeaway and a source caption.',
    },
  ],
});
const input = {
  userId: 'u',
  instruction: 'Explain package delivery',
  audience: 'Operations team',
  evidence: [{ id: 'report', source: 'Verified report', content: '152 blocked packages.' }],
  slideCount: 1,
};
describe('evidence-led presentation planning', () => {
  test('dedicates high reasoning to evidence and tool-backed data/visual construction', async () => {
    const generate = mock(async (options: any) => {
      expect(options).toMatchObject({
        speed: 'primary',
        reasoningEffort: 'high',
        feature: 'presentation_planning',
      });
      expect(JSON.parse(options.prompt).evidence).toEqual(input.evidence);
      return { object: plan() };
    });
    const result = await planPresentation(input, generate as any);
    expect(result.ok).toBe(true);
    expect(result.readyToBuild).toBe(true);
    expect(result.plan?.slides[0].toolSteps.map((step) => step.tool)).toContain('document_get');
    expect(result.nextStep).toContain('Execute');
  });
  test('unknown evidence IDs trigger internal repair rather than fabricated citations', async () => {
    const generate = mock(async (options: any) => {
      const output = plan();
      if (!JSON.parse(options.prompt).repair) output.slides[0].evidenceIds = ['invented'];
      return { object: output };
    });
    expect((await planPresentation(input, generate as any)).ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(JSON.parse(generate.mock.calls[1][0].prompt).repair[0]).toContain('unknown evidence');
  });
  test('missing source data becomes retrieval work and never a ready chart', async () => {
    const output = plan();
    output.slides[0].evidenceIds = [];
    output.slides[0].missingEvidence = ['Completed package count'];
    const result = await planPresentation(input, (async () => ({ object: output })) as any);
    expect(result.readyToBuild).toBe(false);
    expect(result.issues.join(' ')).toContain('Completed package count');
    expect(result.nextStep).toContain('Retrieve');
  });
  test('an unavailable planner returns recovery work after two attempts', async () => {
    const generate = mock(async () => {
      throw new Error('Service unavailable');
    });
    const result = await planPresentation(input, generate);
    expect(result.ok).toBe(false);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.nextStep).toContain('Retain the gathered evidence');
  });
  test('tool is callable and researched decks get bounded headroom for actual construction', () => {
    expect(liftToolsForAgent('batch', 'UTC')).toHaveProperty('presentation_plan');
    for (const name of presentationPlanSchema.shape.slides.element.shape.toolSteps.element.shape.tool.options)
      expect(getTool(name)).toBeTruthy();
    expect(agentStepLimit([])).toBe(20);
    expect(agentStepLimit([{ content: [{ type: 'tool-call', toolName: 'presentation_plan' }] }])).toBe(40);
  });

  const outline = (count = 9) =>
    presentationOutlineSchema.parse({
      ...plan(),
      slides: Array.from({ length: count }, (_, index) => ({
        ...plan().slides[0],
        title: `Slide ${index + 1}`,
      })),
    });
  test('large decks get a shared narrative and bounded, deep per-slide planning in order', async () => {
    let concurrent = 0;
    let peak = 0;
    const generate = mock(async (options: any) => {
      const prompt = JSON.parse(options.prompt);
      expect(options.reasoningEffort).toBe('high');
      expect(options.maxOutputTokens).toBeLessThan(10000);
      expect(options.maxRetries).toBe(0);
      expect(prompt.evidence).toEqual(input.evidence);
      if (prompt.phase === 'outline') return { object: outline(17) };
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 2));
      concurrent--;
      expect(prompt.outline.slides).toHaveLength(17);
      return {
        object: {
          slides: Array.from({ length: prompt.slideCount }, (_, index) => ({
            ...plan().slides[0],
            title: `Slide ${prompt.firstSlideNumber + index}`,
          })),
        },
      };
    });
    const result = await planPresentation({ ...input, slideCount: 17 }, generate as any);
    expect(result.ok).toBe(true);
    expect(result.plan?.slides.map((slide) => slide.title)).toEqual(
      outline(17).slides.map((slide) => slide.title),
    );
    expect(peak).toBe(3);
    expect(generate).toHaveBeenCalledTimes(6);
  });
  test('a failing section retries only that section and retains all other slide work', async () => {
    const generate = mock(async (options: any) => {
      const prompt = JSON.parse(options.prompt);
      if (prompt.phase === 'outline') return { object: outline() };
      if (prompt.firstSlideNumber === 5) throw new Error('section timed out');
      return { object: { slides: Array.from({ length: prompt.slideCount }, () => plan().slides[0]) } };
    });
    const result = await planPresentation({ ...input, slideCount: 9 }, generate as any);
    expect(result.ok).toBe(false);
    expect(result.readyToBuild).toBe(false);
    expect(result.plan).toBeUndefined();
    expect(result.recovery?.pendingSlideNumbers).toEqual([5, 6, 7, 8]);
    expect(result.recovery?.completedSlides.map((slide) => slide.slideNumber)).toEqual([1, 2, 3, 4, 9]);
    expect(presentationPlanningRecoverySchema.safeParse(result.recovery).success).toBe(true);
    expect(result.issues.join(' ')).toContain('Slides 5–8: section timed out');
    expect(generate).toHaveBeenCalledTimes(5);
    expect(result.nextStep).toContain('Continue NOW');
  });
  test('the total deadline aborts stalled requests and returns completed sections for recovery', async () => {
    let sectionSignal: AbortSignal | undefined;
    const result = await planPresentation(
      { ...input, slideCount: 9 },
      (async (options: any) => {
        const prompt = JSON.parse(options.prompt);
        if (prompt.phase === 'outline') return { object: outline() };
        if (prompt.firstSlideNumber === 1)
          return { object: { slides: Array.from({ length: 4 }, () => plan().slides[0]) } };
        sectionSignal = options.abortSignal;
        return new Promise(() => {});
      }) as any,
      { budgetMs: 250, requestTimeoutMs: 5000 },
    );
    expect(sectionSignal?.aborted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.recovery?.completedSlides).toHaveLength(4);
    expect(result.recovery?.pendingSlideNumbers).toEqual([5, 6, 7, 8, 9]);
  });
  test('a request timeout retries locally; parent cancellation never becomes remediation', async () => {
    let calls = 0;
    const result = await planPresentation(
      input,
      (async () => (++calls === 1 ? new Promise(() => {}) : { object: plan() })) as any,
      { requestTimeoutMs: 5 },
    );
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    const controller = new AbortController();
    const promise = planPresentation({ ...input, abortSignal: controller.signal }, (async () => {
      controller.abort(new Error('User stopped'));
      return { object: plan() };
    }) as any);
    await expect(promise).rejects.toThrow('User stopped');
  });
  test('invalid counts and oversized text are repaired before planning succeeds', async () => {
    for (const invalid of [
      { ...plan(), slides: [] },
      { ...plan(), slides: [{ ...plan().slides[0], takeaway: 'x'.repeat(401) }] },
    ]) {
      let calls = 0;
      const result = await planPresentation(input, (async () => ({
        object: ++calls === 1 ? invalid : plan(),
      })) as any);
      expect(result.ok).toBe(true);
      expect(calls).toBe(2);
    }
    let calls = 0;
    const result = await planPresentation({ ...input, slideCount: 5 }, (async (options: any) => {
      const prompt = JSON.parse(options.prompt);
      if (prompt.phase === 'outline') return { object: outline(++calls === 1 ? 6 : 5) };
      return { object: { slides: Array.from({ length: prompt.slideCount }, () => plan().slides[0]) } };
    }) as any);
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });
});

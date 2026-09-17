import { describe, expect, mock, test } from 'bun:test';
import { agentStepLimit, liftToolsForAgent } from '../lib/ai/loop';
import { type PresentationPlan, planPresentation } from '../lib/documents/presentation-plan';

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
    expect(agentStepLimit([])).toBe(20);
    expect(agentStepLimit([{ content: [{ type: 'tool-call', toolName: 'presentation_plan' }] }])).toBe(40);
  });
});

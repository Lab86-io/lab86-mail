import { describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { z } from 'zod';
import {
  extractJsonObjectText,
  fitPreparedDraft,
  fitResearchQueries,
  PREPARED_DRAFT_LIMITS as L,
  type PreparedDraftModelOutput,
  preparationRetryDelayMs,
  preparedDraftModelSchema,
  preparedDraftSchema,
  researchPlanModelSchema,
} from '../lib/content/contract';
import { prepareBriefWork } from '../lib/content/prepare';

// Keywords that Anthropic structured output (also through OpenRouter) does not
// enforce. A schema that sends them lets Opus return an object that the
// stored schema then rejects after a paid call.
const UNENFORCED = ['maxItems', 'minItems', 'maxLength', 'minLength', 'pattern'];
function keywords(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const entry of value) keywords(entry, found);
  else if (value && typeof value === 'object')
    for (const [key, entry] of Object.entries(value)) {
      found.add(key);
      keywords(entry, found);
    }
  return found;
}

function modelDraft(overrides: Partial<PreparedDraftModelOutput> = {}): PreparedDraftModelOutput {
  return {
    title: 'Launch plan',
    shape: 'project',
    situation: 'Approval is needed.',
    background: 'The requirements require approval.',
    assessment: 'Collect it before launch.',
    recommendation: 'Review the draft.',
    questions: [],
    steps: ['Collect approval'],
    files: [{ name: 'plan.md', content: '# Plan\nCollect approval.' }],
    evidence: [{ sourceId: 'seed', quote: 'Approval is required.' }],
    ...overrides,
  };
}

describe('the model schemas send only what every provider enforces', () => {
  test('no length, count, or pattern keyword reaches the model', () => {
    for (const schema of [preparedDraftModelSchema, researchPlanModelSchema]) {
      const sent = keywords(z.toJSONSchema(schema));
      for (const keyword of UNENFORCED) expect(sent.has(keyword)).toBe(false);
    }
    // The stored schema keeps its limits.
    const stored = keywords(z.toJSONSchema(preparedDraftSchema));
    expect(stored.has('maxItems')).toBe(true);
    expect(stored.has('pattern')).toBe(true);
  });

  test('the descriptions tell the model the limits', () => {
    const json = JSON.stringify(z.toJSONSchema(preparedDraftModelSchema));
    expect(json).toContain(`At most ${L.steps} steps`);
    expect(JSON.stringify(z.toJSONSchema(researchPlanModelSchema))).toContain('4 or fewer');
  });
});

describe('fitting the model output to the stored draft', () => {
  test('a draft inside the limits does not change', () => {
    const draft = modelDraft();
    expect(preparedDraftSchema.parse(fitPreparedDraft(draft, 'seed'))).toEqual(draft as any);
  });

  test('long text, long lists, and empty entries fit the stored schema', () => {
    const fitted = fitPreparedDraft(
      modelDraft({
        title: `  ${'T'.repeat(400)}  `,
        situation: 'S'.repeat(5000),
        background: 'B'.repeat(5000),
        assessment: 'A'.repeat(5000),
        recommendation: 'R'.repeat(5000),
        questions: ['', ...Array.from({ length: 9 }, (_, i) => `Question ${i} ${'q'.repeat(900)}`)],
        steps: Array.from({ length: 14 }, (_, i) => `Step ${i}`),
      }),
      'seed',
    );
    expect(() => preparedDraftSchema.parse(fitted)).not.toThrow();
    expect(fitted.title).toHaveLength(L.title);
    expect(fitted.situation).toHaveLength(L.situation);
    expect(fitted.questions).toHaveLength(L.questions);
    expect(fitted.questions[0]).toStartWith('Question 0');
    expect(fitted.questions.every((q) => q.length <= L.question)).toBe(true);
    expect(fitted.steps).toEqual(Array.from({ length: L.steps }, (_, i) => `Step ${i}`));
  });

  test('file names keep only allowed characters, and empty or extra files go', () => {
    const fitted = fitPreparedDraft(
      modelDraft({
        files: [
          { name: 'Budget / Q4: plan?.CSV', content: 'a,b' },
          { name: 'notes.pdf', content: 'Notes' },
          { name: 'empty.md', content: '   ' },
          { name: '***', content: 'Fallback name' },
          { name: 'fourth.md', content: 'Too many' },
        ],
      }),
    );
    expect(fitted.files.map((file) => file.name)).toEqual([
      'Budget - Q4- plan.csv',
      'notes.pdf.md',
      'draft.md',
    ]);
    const long = fitPreparedDraft(modelDraft({ files: [{ name: `${'n'.repeat(300)}.txt`, content: 'x' }] }));
    expect(long.files[0].name).toHaveLength(L.fileName);
    expect(() => preparedDraftSchema.parse(long)).not.toThrow();
  });

  test('quotes keep their start, stay exact, and one trigger quote stays in a long list', () => {
    const source = `Opening line. ${'x'.repeat(2000)}`;
    const evidence = [
      { sourceId: 'other', quote: '   ' },
      ...Array.from({ length: 14 }, (_, i) => ({ sourceId: 'other', quote: `Other ${i}` })),
      { sourceId: 'seed', quote: `  ${source}  ` },
    ];
    const fitted = fitPreparedDraft(modelDraft({ evidence }), 'seed');
    expect(fitted.evidence).toHaveLength(L.evidence);
    const trigger = fitted.evidence.at(-1)!;
    expect(trigger.sourceId).toBe('seed');
    expect(trigger.quote).toHaveLength(L.quote);
    expect(source.includes(trigger.quote)).toBe(true);
    // Without a trigger id, the list keeps its first entries.
    expect(fitPreparedDraft(modelDraft({ evidence })).evidence.every((e) => e.sourceId === 'other')).toBe(
      true,
    );
  });

  test('research queries are distinct, cut, and at most four', () => {
    expect(
      fitResearchQueries([
        ' Launch plan ',
        'launch plan',
        '',
        'q'.repeat(400),
        'Deposit',
        'AV list',
        'Budget',
      ]),
    ).toEqual(['Launch plan', 'q'.repeat(160), 'Deposit', 'AV list']);
    expect(fitResearchQueries([])).toEqual([]);
  });

  test('prose or a code fence around the JSON object is removed', async () => {
    expect(await extractJsonObjectText({ text: 'Here it is:\n```json\n{"queries":["a"]}\n```' })).toBe(
      '{"queries":["a"]}',
    );
    expect(await extractJsonObjectText({ text: 'No object here' })).toBeNull();
  });

  test('a repeated failure waits longer each time, at most one day', () => {
    expect(preparationRetryDelayMs(1)).toBe(10 * 60_000);
    expect(preparationRetryDelayMs(2)).toBe(20 * 60_000);
    expect(preparationRetryDelayMs(4)).toBe(80 * 60_000);
    expect(preparationRetryDelayMs(40)).toBe(24 * 3_600_000);
    expect(preparationRetryDelayMs(0)).toBe(10 * 60_000);
    expect(preparationRetryDelayMs(Number.NaN)).toBe(10 * 60_000);
  });
});

test('an Opus answer longer than the limits still prepares the work', async () => {
  const seed: any = {
    _id: 'seed',
    title: 'Offsite',
    text: 'The venue needs the signed contract and the 30% deposit by Friday.',
    version: 'v1',
    source: 'document',
    modifiedAt: 1,
    partial: false,
  };
  const calls: any[] = [];
  const searched: string[] = [];
  const writes: any[] = [];
  const result = await prepareBriefWork('owner', {
    convexMutation: async (ref: any, args: any) => {
      writes.push({ name: getFunctionName(ref), ...args });
      return getFunctionName(ref).endsWith(':claim')
        ? { _id: 'proposal', lease: 'lease', revision: 1, seed, userNotes: '' }
        : true;
    },
    convexQuery: async () => [seed],
    generateObjectForCurrentUser: async (args: any) => {
      calls.push(args);
      if (args.feature === 'brief_preparation_research')
        // The real Opus 5.5 answer to this kind of source had ten queries.
        return { object: { queries: Array.from({ length: 10 }, (_, i) => `Venue query ${i}`) } };
      return {
        object: modelDraft({
          steps: Array.from({ length: 12 }, (_, i) => `Step ${i}`),
          evidence: [{ sourceId: 'seed', quote: 'the signed contract and the 30% deposit by Friday.' }],
        }),
      };
    },
    searchContent: async (_userId: string, query: string) => {
      searched.push(query);
      return { items: [seed], semanticUnavailable: false };
    },
    voiceProfile: async () => null,
    reportFailure: () => {
      throw new Error('the preparation must not fail');
    },
  } as any);
  expect(result.prepared).toBe(true);
  expect(searched).toEqual(['Venue query 0', 'Venue query 1', 'Venue query 2', 'Venue query 3']);
  expect(calls[0]).toMatchObject({ schema: researchPlanModelSchema, maxOutputTokens: 4000 });
  expect(calls[0].system).toContain('{"queries": [...]}');
  expect(calls[1].schema).toBe(preparedDraftModelSchema);
  expect(JSON.parse(calls[1].prompt).researchCoverage.searchedQueries).toHaveLength(4);
  for (const call of calls) expect(call.experimental_repairText).toBe(extractJsonObjectText);
  const complete = writes.find((write) => write.name.endsWith(':complete'));
  expect(complete.draft.steps).toHaveLength(L.steps);
});

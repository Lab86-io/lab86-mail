import { describe, expect, test } from 'bun:test';
import { type PlanContextRef, parsePlanGeneration, resolveSourceRefs } from '../lib/albatross/intent-plan';

const validPlan = {
  title: 'Finish passport application',
  kind: 'obligation',
  priority: 1,
  areaName: null,
  projectTitle: null,
  outcome: 'A submitted passport application with confirmation number.',
  summary: 'You already have the form; what remains is photos, payment, and submission.',
  questions: [{ id: 'q1', prompt: 'Is this a renewal or a first passport?' }],
  digitalActions: [
    { kind: 'task', title: 'Get passport photos taken', priority: 2 },
    {
      kind: 'calendar_event',
      title: 'Passport paperwork hour',
      startIso: '2026-07-03T09:00:00Z',
      endIso: '2026-07-03T10:00:00Z',
    },
  ],
  physicalActions: [{ title: 'Bring documents to the post office', url: 'https://travel.state.gov' }],
  assumptions: ['You are applying from the US'],
  sourceRefIds: ['ref1'],
};

describe('parsePlanGeneration', () => {
  test('parses a clean JSON object', () => {
    const plan = parsePlanGeneration(JSON.stringify(validPlan));
    expect(plan.title).toBe('Finish passport application');
    expect(plan.digitalActions).toHaveLength(2);
    expect(plan.questions[0].prompt).toContain('renewal');
  });

  test('strips markdown fences and surrounding prose', () => {
    const raw = `Here is the plan you asked for:\n\`\`\`json\n${JSON.stringify(validPlan)}\n\`\`\`\nLet me know!`;
    const plan = parsePlanGeneration(raw);
    expect(plan.outcome).toContain('confirmation number');
  });

  test('repairs by dropping malformed array entries instead of failing the plan', () => {
    const damaged = {
      ...validPlan,
      digitalActions: [
        ...validPlan.digitalActions,
        { kind: 'email_send', title: 'Not an allowed generated kind' },
        { title: 'missing kind entirely' },
      ],
      questions: [...validPlan.questions, { prompt: '' }],
    };
    const plan = parsePlanGeneration(JSON.stringify(damaged));
    expect(plan.digitalActions).toHaveLength(2);
    expect(plan.questions).toHaveLength(1);
  });

  test('coerces unknown kind to "unknown" rather than failing', () => {
    const plan = parsePlanGeneration(JSON.stringify({ ...validPlan, kind: 'chore' }));
    expect(plan.kind).toBe('unknown');
  });

  test('throws when there is no JSON object at all', () => {
    expect(() => parsePlanGeneration('I could not make a plan, sorry.')).toThrow(/no JSON object/);
  });

  test('throws when required fields are missing after repair', () => {
    expect(() => parsePlanGeneration(JSON.stringify({ title: 'x' }))).toThrow(/failed validation/);
  });
});

describe('resolveSourceRefs', () => {
  const pack: PlanContextRef[] = [
    { refId: 'ref1', kind: 'mail_thread', id: 'thread-a', label: 'Passport receipt', accountId: 'acct1' },
    { refId: 'ref2', kind: 'mcp_item', id: 'issue-9', url: 'https://github.com/x/y/issues/9' },
  ];

  test('resolves only refs that exist in the context pack', () => {
    const refs = resolveSourceRefs(['ref2', 'ref-hallucinated', 'ref1'], pack);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ kind: 'mcp_item', id: 'issue-9' });
    expect(refs[1]).toMatchObject({ kind: 'mail_thread', id: 'thread-a', accountId: 'acct1' });
  });

  test('dedupes repeated ref ids', () => {
    expect(resolveSourceRefs(['ref1', 'ref1', 'ref1'], pack)).toHaveLength(1);
  });

  test('handles undefined and empty inputs', () => {
    expect(resolveSourceRefs(undefined, pack)).toHaveLength(0);
    expect(resolveSourceRefs([], [])).toHaveLength(0);
  });
});

describe('generateIntentPlan orchestration', () => {
  const { __setIntentPlanDepsForTest, generateIntentPlan } = require('../lib/albatross/intent-plan');

  const fakeApi = {
    albatross: { listAreas: 'q:listAreas', listVerifiedFacts: 'q:listVerifiedFacts' },
    albatrossIntents: {
      getIntentWorkbench: 'q:getIntentWorkbench',
      updateIntent: 'm:updateIntent',
      savePlan: 'm:savePlan',
    },
  };

  const AREAS = [
    { _id: 'area_money', name: 'Money Management', kind: 'admin', description: 'Taxes and money' },
    { _id: 'area_apps', name: 'My Apps', kind: 'work' },
  ];
  const FACTS = [{ areaId: 'area_money', kind: 'website', value: 'tax.ny.gov', label: 'NYS taxes' }];
  const CORPUS_ITEMS = [
    {
      source: 'mail',
      threadId: 'thread-tax',
      subject: 'Your NYS tax receipt',
      from: 'tax@ny.gov',
      account: 'acct1',
      snippet: 'Payment received',
    },
  ];

  const goodGeneration = {
    title: 'Upload NYS taxes',
    kind: 'obligation',
    priority: 1,
    areaName: 'money management',
    projectTitle: 'Tax season wrap-up',
    outcome: 'NYS taxes uploaded and confirmed.',
    summary: 'The receipt thread suggests payment happened; upload remains.',
    questions: [{ id: 'q1', prompt: 'Did you already file federal?' }],
    digitalActions: [{ kind: 'task', title: 'Upload NYS tax PDF', sourceRefIds: ['ref1', 'bogus'] }],
    physicalActions: [{ title: 'Find the paper W-2' }],
    assumptions: ['Payment already went through'],
    sourceRefIds: ['ref1'],
    mapQuery: 'NYS Tax Department, Albany NY',
  };

  function wire(overrides: {
    intent?: Record<string, unknown>;
    planText?: string;
    artifactText?: string | Error;
  }) {
    const calls: { mutations: Array<{ fn: string; args: any }>; generations: any[] } = {
      mutations: [],
      generations: [],
    };
    const intent = {
      _id: 'intent_1',
      rawText: 'make sure I upload my nys taxes',
      transcript: undefined,
      questions: [{ id: 'q1', prompt: 'Did you already file federal?', answer: 'yes', answeredAt: 5 }],
      ...(overrides.intent || {}),
    };
    __setIntentPlanDepsForTest({
      api: fakeApi,
      convexQuery: async (fn: string) => {
        if (fn === 'q:getIntentWorkbench') return { intent, plan: null };
        if (fn === 'q:listAreas') return AREAS;
        if (fn === 'q:listVerifiedFacts') return FACTS;
        throw new Error(`unexpected query ${fn}`);
      },
      convexMutation: async (fn: string, args: any) => {
        calls.mutations.push({ fn, args });
        if (fn === 'm:savePlan') return 'plan_1';
        return null;
      },
      invokeTool: async () => ({ items: CORPUS_ITEMS }),
      generateTextForCurrentUser: async (options: any) => {
        calls.generations.push(options);
        if (options.feature === 'albatross_plan') {
          return { text: overrides.planText ?? JSON.stringify(goodGeneration) };
        }
        if (overrides.artifactText instanceof Error) throw overrides.artifactText;
        return {
          text:
            overrides.artifactText ??
            `<!doctype html><html><body><h1>Plan brief</h1><p>${'brief '.repeat(60)}</p></body></html>`,
        };
      },
    });
    return { calls, intent };
  }

  test('happy path: saves a grounded plan with area match, clamped refs, artifact, and project title', async () => {
    const { calls } = wire({});
    const result = await generateIntentPlan({
      userId: 'user_1',
      intentId: 'intent_1',
      timezone: 'America/New_York',
    });
    expect(result.planId).toBe('plan_1');
    expect(result.projectTitle).toBe('Tax season wrap-up');

    const planning = calls.mutations.find((m) => m.fn === 'm:updateIntent');
    expect(planning?.args.status).toBe('planning');

    const save = calls.mutations.find((m) => m.fn === 'm:savePlan');
    expect(save).toBeTruthy();
    expect(save!.args.areaId).toBe('area_money');
    expect(save!.args.proposedProjectTitle).toBe('Tax season wrap-up');
    expect(save!.args.mapQuery).toBe('NYS Tax Department, Albany NY');
    expect(save!.args.artifactHtml).toContain('<!doctype html>');
    // Hallucinated 'bogus' ref dropped; real corpus ref kept with account id.
    expect(save!.args.digitalActions[0].sourceRefs).toEqual([
      expect.objectContaining({ kind: 'mail_thread', id: 'thread-tax', accountId: 'acct1' }),
    ]);
    // Answered question carried over by matching prompt.
    expect(save!.args.questions[0].answer).toBe('yes');
    expect(save!.args.questions[0].answeredAt).toBe(5);

    // Plan prompt included the raw dump, answers block, area facts, and evidence.
    const planPrompt = calls.generations[0].prompt as string;
    expect(planPrompt).toContain('make sure I upload my nys taxes');
    expect(planPrompt).toContain('The user answered your earlier questions');
    expect(planPrompt).toContain('Money Management');
    expect(planPrompt).toContain('[ref1] (mail_thread)');
    expect(planPrompt).toContain('America/New_York');
  });

  test('artifact composition failure still saves the plan without a brief', async () => {
    const { calls } = wire({ artifactText: new Error('provider down') });
    const result = await generateIntentPlan({ userId: 'user_1', intentId: 'intent_1' });
    expect(result.planId).toBe('plan_1');
    const save = calls.mutations.find((m) => m.fn === 'm:savePlan');
    expect(save!.args.artifactHtml).toBeUndefined();
  });

  test('unparseable generation records planError and returns intent to captured', async () => {
    const { calls } = wire({ planText: 'I refuse to answer in JSON.' });
    await expect(generateIntentPlan({ userId: 'user_1', intentId: 'intent_1' })).rejects.toThrow(
      /no JSON object/,
    );
    const updates = calls.mutations.filter((m) => m.fn === 'm:updateIntent');
    const last = updates[updates.length - 1];
    expect(last.args.status).toBe('captured');
    expect(last.args.planError).toContain('no JSON object');
    expect(calls.mutations.some((m) => m.fn === 'm:savePlan')).toBe(false);
  });

  test('voice transcript differing from raw text is included in the prompt', async () => {
    const { calls } = wire({
      intent: { rawText: 'upload nys taxes', transcript: 'upload en why ess taxes', questions: [] },
    });
    await generateIntentPlan({ userId: 'user_1', intentId: 'intent_1' });
    expect(calls.generations[0].prompt).toContain('voice transcript: upload en why ess taxes');
  });
});

describe('generateIntentPlan nearby options (geo)', () => {
  const { __setIntentPlanDepsForTest, generateIntentPlan } = require('../lib/albatross/intent-plan');

  test('geo triggers reverse geocode, local search, and option-bearing questions', async () => {
    const calls: { mutations: any[]; generations: any[]; searches: any[] } = {
      mutations: [],
      generations: [],
      searches: [],
    };
    const generationWithOptions = {
      title: 'Get guitar strings',
      kind: 'errand',
      priority: 2,
      areaName: null,
      projectTitle: null,
      outcome: 'New strings bought and on the guitar.',
      summary: 'Two well-reviewed shops are nearby.',
      places: [
        {
          name: 'Parkway Music',
          address: '99 Route 9, Clifton Park',
          website: 'https://parkwaymusic.com',
          hoursText: 'Mon-Sat 10-6',
          mapsQuery: 'Parkway Music, Clifton Park NY',
        },
      ],
      questions: [
        {
          id: 'q1',
          prompt: 'Which store should the plan use?',
          options: [
            {
              title: 'Parkway Music',
              address: '99 Route 9, Clifton Park',
              website: 'https://parkwaymusic.com',
              hoursText: 'Mon-Sat 10-6',
            },
            { title: 'Guitar Center Albany', address: '1 Crossgates Mall Rd' },
          ],
        },
      ],
      digitalActions: [{ kind: 'task', title: 'Buy strings' }],
      physicalActions: [],
      assumptions: [],
      sourceRefIds: [],
    };
    __setIntentPlanDepsForTest({
      api: {
        albatross: { listAreas: 'q:listAreas', listVerifiedFacts: 'q:listVerifiedFacts' },
        albatrossIntents: {
          getIntentWorkbench: 'q:getIntentWorkbench',
          updateIntent: 'm:updateIntent',
          savePlan: 'm:savePlan',
        },
      },
      convexQuery: async (fn: string) => {
        if (fn === 'q:getIntentWorkbench') {
          return {
            intent: { _id: 'intent_1', rawText: 'I have to go to the guitar store', questions: [] },
            plan: null,
          };
        }
        return [];
      },
      convexMutation: async (fn: string, args: any) => {
        calls.mutations.push({ fn, args });
        return fn === 'm:savePlan' ? 'plan_1' : null;
      },
      invokeTool: async (tool: any, args: any) => {
        if (tool.name === 'browserbase_search') {
          calls.searches.push(args);
          return {
            results: [
              {
                title: 'Parkway Music',
                url: 'https://parkwaymusic.com',
                snippet: '99 Route 9 · Mon-Sat 10-6',
              },
              { title: 'Guitar Center Albany', url: 'https://gc.example', snippet: 'Crossgates Mall' },
            ],
          };
        }
        return { items: [] };
      },
      httpGetJson: async (url: string) => {
        expect(url).toContain('nominatim.openstreetmap.org/reverse');
        return { address: { city: 'Albany', state: 'New York' } };
      },
      generateTextForCurrentUser: async (options: any) => {
        calls.generations.push(options);
        if (options.feature === 'albatross_local') return { text: '{"query": "guitar stores"}' };
        if (options.feature === 'albatross_plan') return { text: JSON.stringify(generationWithOptions) };
        return { text: `<!doctype html><html><body>${'b'.repeat(300)}</body></html>` };
      },
    });

    await generateIntentPlan({
      userId: 'user_1',
      intentId: 'intent_1',
      geo: { latitude: 42.65, longitude: -73.75 },
    });

    expect(calls.searches[0].query).toBe('guitar stores near Albany, New York hours address');
    const planGen = calls.generations.find((g) => g.feature === 'albatross_plan');
    expect(planGen.prompt).toContain('user is near Albany, New York');
    expect(planGen.prompt).toContain('## Nearby places');
    expect(planGen.prompt).toContain('Parkway Music');

    const save = calls.mutations.find((m) => m.fn === 'm:savePlan');
    const question = save!.args.questions[0];
    expect(question.options).toHaveLength(2);
    expect(question.options[0].id).toBe('q1o1');
    expect(question.options[0].address).toContain('Route 9');
    expect(save!.args.places).toHaveLength(1);
    expect(save!.args.places[0].hoursText).toBe('Mon-Sat 10-6');
    // No explicit mapQuery in this generation: the first place's mapsQuery drives the map.
    expect(save!.args.mapQuery).toBe('Parkway Music, Clifton Park NY');
  });

  test('no geo skips geocode, local pre-pass, and nearby search entirely', async () => {
    const calls: string[] = [];
    __setIntentPlanDepsForTest({
      api: {
        albatross: { listAreas: 'q:listAreas', listVerifiedFacts: 'q:listVerifiedFacts' },
        albatrossIntents: {
          getIntentWorkbench: 'q:getIntentWorkbench',
          updateIntent: 'm:updateIntent',
          savePlan: 'm:savePlan',
        },
      },
      convexQuery: async (fn: string) =>
        fn === 'q:getIntentWorkbench'
          ? { intent: { _id: 'intent_1', rawText: 'go to the guitar store', questions: [] }, plan: null }
          : [],
      convexMutation: async (fn: string) => (fn === 'm:savePlan' ? 'plan_1' : null),
      invokeTool: async (tool: any) => {
        calls.push(tool.name);
        return { items: [], results: [] };
      },
      httpGetJson: async () => {
        throw new Error('should not geocode without geo');
      },
      generateTextForCurrentUser: async (options: any) => {
        calls.push(options.feature);
        if (options.feature === 'albatross_plan') {
          return {
            text: JSON.stringify({
              title: 'Guitar store',
              kind: 'errand',
              outcome: 'Done.',
              questions: [],
              digitalActions: [],
              physicalActions: [],
              assumptions: [],
              sourceRefIds: [],
            }),
          };
        }
        return { text: `<!doctype html><html><body>${'b'.repeat(300)}</body></html>` };
      },
    });
    await generateIntentPlan({ userId: 'user_1', intentId: 'intent_1' });
    expect(calls).not.toContain('albatross_local');
    expect(calls.filter((c) => c === 'browserbase_search')).toHaveLength(0);
  });
});

describe('normalizeArtifactLinks', () => {
  const { normalizeArtifactLinks } = require('../lib/albatross/intent-plan');

  test('adds https to bare-domain hrefs (the 0.0.0.0 bug) and leaves real URLs alone', () => {
    const html =
      '<head></head><a href="dmv.ny.gov/edl">EDL</a> <a href="https://ok.com/x">ok</a> <a href="mailto:a@b.c">m</a> <a href="#top">t</a>';
    const out = normalizeArtifactLinks(html);
    expect(out).toContain('href="https://dmv.ny.gov/edl"');
    expect(out).toContain('href="https://ok.com/x"');
    expect(out).toContain('href="mailto:a@b.c"');
    expect(out).toContain('href="#top"');
  });

  test('injects base target so links open outside the sandbox', () => {
    const out = normalizeArtifactLinks('<head></head><body></body>');
    expect(out).toContain('<base target="_blank">');
    // Never doubled when the model already emitted one.
    const twice = normalizeArtifactLinks(out);
    expect(twice.match(/<base /g)?.length).toBe(1);
  });

  test('fixes bare-domain iframe/img src but leaves data: and https: alone', () => {
    const out = normalizeArtifactLinks(
      '<head></head><iframe src="www.google.com/maps?q=x&output=embed"></iframe><img src="data:image/png;base64,x">',
    );
    expect(out).toContain('src="https://www.google.com/maps?q=x&output=embed"');
    expect(out).toContain('src="data:image/png;base64,x"');
  });
});

import { describe, expect, test } from 'bun:test';
import {
  attachResearchRefs,
  escapePlanHtml,
  mergePlanQuestions,
  type PlanContextRef,
  parsePlanGeneration,
  resolveSourceRefs,
} from '../lib/albatross/intent-plan';

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
  test('escapes every HTML-significant character in the static fallback', () => {
    expect(escapePlanHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

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

  test('keeps grounded document actions and drops incomplete document proposals', () => {
    const plan = parsePlanGeneration(
      JSON.stringify({
        ...validPlan,
        digitalActions: [
          {
            kind: 'document',
            title: 'Draft the decision memo',
            documentKind: 'doc',
            instructions: 'Use the cited vendor comparison to explain the recommendation.',
            sourceRefIds: ['ref1'],
          },
          {
            kind: 'document',
            title: 'Missing the required file kind',
            instructions: 'Draft something.',
          },
          {
            kind: 'document',
            title: 'Missing grounded instructions',
            documentKind: 'sheet',
          },
        ],
      }),
    );

    expect(plan.digitalActions).toEqual([
      expect.objectContaining({
        kind: 'document',
        documentKind: 'doc',
        title: 'Draft the decision memo',
      }),
    ]);
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

describe('planner research provenance', () => {
  test('turns every supported research result into bounded, reusable plan refs', () => {
    const refs: PlanContextRef[] = [];
    expect(attachResearchRefs('mcp_search', null, refs, {})).toBeNull();

    const fetched = attachResearchRefs('browserbase_fetch', { content: 'x'.repeat(30_000) }, refs, {
      url: 'https://travel.state.gov/passports',
    });
    expect(fetched.content).toHaveLength(24_000);
    expect(fetched.refId).toBe('ref1');

    const cases = [
      ['calendar_search_events', { events: [{ providerEventId: 'provider-1', title: 'Appointment' }] }],
      ['calendar_search_events', { events: [{ eventId: 'event-2', name: 'Focus hold' }] }],
      [
        'corpus_search',
        {
          items: [
            { source: 'mcp', externalId: 'meeting-1', summary: 'Granola meeting notes' },
            { source: 'mail', threadId: 'thread-1', subject: 'Receipt', account: 'mail-1' },
          ],
        },
      ],
      [
        'github_search',
        {
          items: [
            { id: 'gh-1', kind: 'pull_request', title: 'PR' },
            { id: 'gh-2', kind: 'commit', title: 'Commit' },
            { id: 'gh-3', kind: 'project', title: 'Project' },
            { id: 'gh-4', kind: 'project_item', title: 'Project item' },
            { id: 'gh-5', kind: 'issue', title: 'Issue' },
          ],
        },
      ],
      ['mcp_list_items', { items: [{ id: 'mcp-1', title: 'Meeting' }] }],
      ['cloud_file_search', { files: [{ webUrl: 'https://drive.test/file', name: 'Application.pdf' }] }],
      ['browserbase_search', { results: [{ url: 'https://usa.gov/passport', title: 'Passport help' }] }],
    ] as const;

    for (const [toolName, result] of cases) {
      const attached = attachResearchRefs(toolName, result, refs, {});
      const rows = attached.items || attached.files || attached.events || attached.results;
      expect(rows.every((row: any) => row.refId)).toBe(true);
    }

    const duplicate = attachResearchRefs(
      'mcp_search',
      { items: [{ id: 'mcp-1', title: 'Same meeting, fresher label' }] },
      refs,
      {},
    );
    expect(duplicate.items[0].refId).toBe(refs.find((ref) => ref.id === 'mcp-1')?.refId);
    expect(attachResearchRefs('mcp_connection_status', { connections: [] }, refs, {})).toEqual({
      connections: [],
    });
    expect(new Set(refs.map((ref) => ref.kind))).toEqual(
      new Set([
        'manual',
        'calendar_event',
        'mcp_item',
        'mail_thread',
        'github_pull_request',
        'github_commit',
        'github_project',
        'github_project_item',
        'github_issue',
      ]),
    );
  });
});

describe('generateIntentPlan orchestration', () => {
  const { __setIntentPlanDepsForTest, generateIntentPlan } = require('../lib/albatross/intent-plan');

  const fakeApi = {
    albatross: {
      listAreas: 'q:listAreas',
      listVerifiedFacts: 'q:listVerifiedFacts',
      areaHome: 'q:areaHome',
    },
    albatrossIntents: {
      getIntentWorkbench: 'q:getIntentWorkbench',
      updateIntent: 'm:updateIntent',
      savePlan: 'm:savePlan',
    },
    albatrossWorkV2: { workDetail: 'q:workDetail' },
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
    { source: 'mcp', id: 'gh-1', title: 'Tax importer PR', url: 'https://github.com/lab86/tax/pull/1' },
    { source: 'mcp', id: 'bb-1', title: 'Pipeline run', url: 'https://bitbucket.org/lab86/tax' },
    { source: 'mcp', id: 'jr-1', title: 'TAX-12', url: 'https://acme.atlassian.net/browse/TAX-12' },
    { source: 'mcp', id: 'sl-1', title: 'Tax thread', url: 'https://acme.slack.com/archives/C1/p2' },
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
    currentPlan?: Record<string, unknown> | null;
    workDetail?: Record<string, unknown> | null;
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
        if (fn === 'q:getIntentWorkbench') return { intent, plan: overrides.currentPlan ?? null };
        if (fn === 'q:workDetail') return overrides.workDetail ?? null;
        if (fn === 'q:listAreas') return AREAS;
        if (fn === 'q:listVerifiedFacts') return FACTS;
        if (fn === 'q:areaHome') {
          return {
            area: AREAS[0],
            events: [
              {
                providerEventId: 'event-tax-deadline',
                title: 'Tax deadline',
                startAt: Date.parse('2026-07-15T13:00:00Z'),
                endAt: Date.parse('2026-07-15T14:00:00Z'),
              },
            ],
            tasks: [
              {
                cardId: 'card-tax-1',
                title: 'Download the NYS PDF',
                completedAt: Date.parse('2026-07-01T12:00:00Z'),
                dueAt: Date.parse('2026-07-10T12:00:00Z'),
              },
            ],
            projects: [
              {
                projectId: 'project-tax',
                title: 'Tax season',
                status: 'active',
                outcome: 'Both returns filed.',
              },
            ],
          };
        }
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
        // The document composer is tool-driven: emulate a model that places
        // one region and finalizes, the way the live provider does.
        if (options.tools?.place_region) {
          const region = {
            id: 'steps',
            summary: 'The steps to file.',
            tree: {
              kind: 'checklist',
              title: 'Steps',
              items: [{ label: 'Upload NYS tax PDF', stepKey: 'step-1' }],
            },
          };
          // Place the same region twice: the second call exercises the
          // replace-in-place branch the live composer uses for repairs.
          await options.tools.place_region.execute({ region });
          await options.tools.place_region.execute({ region });
          await options.tools.finalize_brief.execute({ title: 'Tax plan', summary: 'The staged plan.' });
          return { text: '' };
        }
        return { text: overrides.artifactText ?? '' };
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
    // The native document is the plan page; the HTML is only the static
    // companion older clients render.
    expect(save!.args.artifactSource).toBe('document-v2');
    const regionIds = save!.args.document.regions.map((region: any) => region.id);
    expect(regionIds.length).toBeGreaterThan(0);
    // The duplicate place_region call in the harness must replace, not append.
    expect(new Set(regionIds).size).toBe(regionIds.length);
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

    // Stable step keys assigned by index and persisted on the plan document.
    expect(save!.args.digitalActions[0].key).toBe('step-1');

    // The planner's system prompt encodes the epic contract: multi-step work
    // (3+ tasks or beyond a week) declares a projectTitle; errands stay null.
    const planSystem = calls.generations[0].system as string;
    expect(planSystem).toContain('Projects are epics that contain multiple tasks');
    expect(planSystem).toContain('3 or more task actions, or work stretching beyond a week');
    expect(planSystem).toContain('REQUIRED for multi-step work');
    expect(planSystem).toContain('calendar_suggest_times');
    expect(planSystem).toContain('add ONE calendar_event');
    expect(Object.keys(calls.generations[0].tools)).toEqual(
      expect.arrayContaining([
        'corpus_search',
        'calendar_search_events',
        'calendar_suggest_times',
        'cloud_file_search',
        'mcp_connection_status',
        'mcp_search',
        'mcp_list_items',
        'github_search',
        'browserbase_search',
        'browserbase_fetch',
      ]),
    );
  });

  test('document composition gets step keys verbatim and routes questions to attached chat', async () => {
    const { calls } = wire({});
    await generateIntentPlan({ userId: 'user_1', intentId: 'intent_1' });
    const artifactGen = calls.generations.find((g: any) => g.feature === 'albatross_plan_artifact');
    expect(artifactGen).toBeTruthy();

    // Data pack: each digital action carries its assigned key.
    const pack = JSON.parse(artifactGen.prompt);
    expect(pack.digitalActions[0].key).toBe('step-1');
    expect(pack.services.map((service: any) => service.id)).toEqual(['mail']);

    // The composer prompt carries the live-page contract: verbatim step keys
    // on checklist items, and no invented inline question/chat experience.
    const system = artifactGen.system as string;
    expect(system).toContain('stepKey');
    expect(system).toContain(`copy that action's "key" verbatim`);
    expect(system).toContain('Never invent a stepKey');
    expect(system).toContain('Do NOT restate them');
    expect(system).toContain('attached Albatross chat');
    expect(system).toContain('Do NOT restate them');
    expect(system).toContain('imitate a chat inside this document');
    expect(system).toContain('Do not invent apply_plan or toggle_step actions');
  });

  test('an open question keeps the page but does not render an embedded chat or gate', async () => {
    const planText = JSON.stringify({
      ...goodGeneration,
      questions: [
        {
          id: 'q9',
          prompt: 'Which office should file this?',
          options: [
            { id: 'q9o1', title: 'Albany office' },
            { id: 'q9o2', title: 'Rochester office' },
          ],
        },
      ],
    });
    const { calls } = wire({ planText, intent: { questions: [] } });
    await generateIntentPlan({ userId: 'user_1', intentId: 'intent_1' });
    const save = calls.mutations.find((m) => m.fn === 'm:savePlan');
    expect(save!.args.artifactSource).toBe('document-v2');
    const regions = save!.args.document.regions;
    expect(regions.some((region: any) => region.id === 'frontier-gate')).toBe(false);
    expect(regions[0].tree.items[0].stepKey).toBe('step-1');
  });

  test('every referenced service reaches the composer pack', async () => {
    const planText = JSON.stringify({
      ...goodGeneration,
      sourceRefIds: ['ref1', 'ref2', 'ref3', 'ref4', 'ref5'],
    });
    const { calls } = wire({ planText });
    await generateIntentPlan({ userId: 'user_1', intentId: 'intent_1' });
    const artifactGen = calls.generations.find((g: any) => g.feature === 'albatross_plan_artifact');
    const pack = JSON.parse(artifactGen.prompt);
    const ids = pack.services.map((service: any) => service.id);
    expect(ids).toContain('mail');
    expect(ids).toContain('github');
    expect(ids).toContain('bitbucket');
    expect(ids).toContain('jira');
    expect(ids).toContain('slack');
  });

  test('null place fields collapse to undefined so savePlan validation cannot reject them', async () => {
    const planText = JSON.stringify({
      ...goodGeneration,
      places: [
        {
          name: 'DMV Rochester',
          detail: null,
          address: '200 State St',
          hoursText: null,
          phone: null,
          website: null,
          mapsQuery: null,
        },
      ],
    });
    const { calls } = wire({ planText });
    await generateIntentPlan({ userId: 'user_1', intentId: 'intent_1' });
    const save = calls.mutations.find((m) => m.fn === 'm:savePlan');
    const place = save!.args.places[0];
    expect(place.name).toBe('DMV Rochester');
    expect(place.address).toBe('200 State St');
    for (const key of ['detail', 'hoursText', 'phone', 'website', 'mapsQuery']) {
      expect(place[key]).toBeUndefined();
    }
  });

  test('the planner classifies shape and savePlan receives it', async () => {
    const planText = JSON.stringify({ ...goodGeneration, shape: 'quick' });
    const { calls } = wire({ planText });
    await generateIntentPlan({ userId: 'user_1', intentId: 'intent_1' });
    const save = calls.mutations.find((m) => m.fn === 'm:savePlan');
    expect(save!.args.shape).toBe('quick');
    const planSystem = calls.generations[0].system as string;
    expect(planSystem).toContain('Classify the shape of each outcome');
  });

  test('Area evidence and corpus evidence receive unique reference ids', async () => {
    const planText = JSON.stringify({
      ...goodGeneration,
      sourceRefIds: ['ref4'],
      digitalActions: [{ kind: 'task', title: 'Upload NYS tax PDF', sourceRefIds: ['ref4'] }],
    });
    const { calls } = wire({ intent: { primaryAreaId: 'area_money' }, planText });

    await generateIntentPlan({ userId: 'user_1', intentId: 'intent_1' });

    const prompt = calls.generations[0].prompt as string;
    expect(prompt).toContain('[ref1] (calendar_event)');
    expect(prompt).toContain('[ref2] (task)');
    expect(prompt).toContain('Download the NYS PDF — completed — due');
    expect(prompt).toContain('[ref3] (project)');
    expect(prompt).toContain('Tax season — active — Both returns filed.');
    expect(prompt).toContain('[ref4] (mail_thread)');
    const save = calls.mutations.find((mutation) => mutation.fn === 'm:savePlan');
    expect(save!.args.sourceRefs).toEqual([
      expect.objectContaining({ kind: 'mail_thread', id: 'thread-tax' }),
    ]);
  });

  test('document composition failure still saves the plan with the static companion', async () => {
    const { calls } = wire({ artifactText: new Error('provider down') });
    const result = await generateIntentPlan({ userId: 'user_1', intentId: 'intent_1' });
    expect(result.planId).toBe('plan_1');
    const save = calls.mutations.find((m) => m.fn === 'm:savePlan');
    expect(save!.args.document).toBeUndefined();
    expect(save!.args.artifactSource).toBeUndefined();
    // The pure legacy companion is built before the composer runs, so a
    // provider failure never leaves the plan with nothing to show.
    expect(save!.args.artifactHtml).toContain('<!doctype html>');
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

  test('replanning sees the current plan and confirmed progress instead of restarting', async () => {
    const currentPlan = {
      _id: 'plan_old',
      outcome: 'NYS taxes filed',
      summary: 'Download, upload, and confirm.',
      digitalActions: [{ title: 'Download the NYS PDF' }, { title: 'Upload the NYS PDF' }],
      physicalActions: [],
    };
    const { calls } = wire({
      currentPlan,
      workDetail: {
        evidence: [
          {
            claim: 'The NYS PDF is already downloaded.',
            sourceKind: 'chat',
            trust: 'confirmed',
            limits: 'No receipt needed for this step.',
          },
        ],
      },
    });
    await generateIntentPlan({ userId: 'user_1', intentId: 'intent_1' });
    const prompt = calls.generations[0].prompt as string;
    expect(prompt).toContain('Current Work state (for plan revision)');
    expect(prompt).toContain('Download the NYS PDF');
    expect(prompt).toContain('already downloaded');
    expect(prompt).toContain('chat, confirmed');
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

describe('assignStepKeys', () => {
  const { assignStepKeys } = require('../lib/albatross/intent-plan');

  test('assigns stable index-based keys without touching action fields', () => {
    const keyed = assignStepKeys([
      { kind: 'task', title: 'A' },
      { kind: 'calendar_event', title: 'B' },
    ]);
    expect(keyed.map((a: any) => a.key)).toEqual(['step-1', 'step-2']);
    expect(keyed[0].title).toBe('A');
  });

  test('empty input stays empty', () => {
    expect(assignStepKeys([])).toEqual([]);
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

describe('withDeadline (stuck-planning guard)', () => {
  test('resolves normally when the promise beats the deadline', async () => {
    const { withDeadline } = await import('../lib/albatross/intent-plan');
    await expect(withDeadline(Promise.resolve('ok'), 1_000, 'Fast op')).resolves.toBe('ok');
  });

  test('rejects with a labeled error when the promise hangs', async () => {
    const { withDeadline } = await import('../lib/albatross/intent-plan');
    const hang = new Promise(() => {});
    await expect(withDeadline(hang, 10, 'Plan generation')).rejects.toThrow(
      'Plan generation timed out after 0s',
    );
  });

  test('propagates the underlying rejection unchanged', async () => {
    const { withDeadline } = await import('../lib/albatross/intent-plan');
    await expect(withDeadline(Promise.reject(new Error('boom')), 1_000, 'Op')).rejects.toThrow('boom');
  });
});

describe('plan reconcile wiring (stuck-planning self-heal)', () => {
  const read = (rel: string) =>
    require('node:fs').readFileSync(require('node:path').join(process.cwd(), rel), 'utf8');

  test('the reconcile cron is registered and the convex side exists', () => {
    const crons = read('convex/crons.ts');
    expect(crons).toContain('planReconcileTick');
    const intents = read('convex/albatrossIntents.ts');
    expect(intents).toContain('export const stalePlanningIntents');
    expect(intents).toContain('export const failStalePlan');
    expect(intents).toContain('export const beginPlanReconcile');
    // Give-up path surfaces the interruption instead of spinning forever.
    expect(intents).toContain('Planning was interrupted. Regenerate to try again.');
    // A successful save resets the retry counter.
    expect(intents).toContain('planAttempts: 0');
  });

  test('the Next route re-runs the full generation under cron auth', () => {
    const route = read('app/api/cron/plan-reconcile/route.ts');
    expect(route).toContain('isInternalCronRequest');
    expect(route).toContain('generateIntentPlan({ userId, intentId })');
  });

  test('schema carries the retry counter', () => {
    expect(read('convex/schema.ts')).toContain('planAttempts: v.optional(v.number())');
  });

  test('every gateway/search call in the generation path has a deadline', () => {
    const src = read('lib/albatross/intent-plan.ts');
    // No bare awaited gateway calls: each generateTextForCurrentUser call is
    // wrapped so a hung provider becomes a caught, planError-writing failure.
    const bare = src.match(/await deps\.generateTextForCurrentUser\(/g) ?? [];
    expect(bare.length).toBe(0);
    expect((src.match(/withDeadline\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
});

describe('mergePlanQuestions (question-loop fix)', () => {
  const q = (id: string, prompt: string, answer?: string) => ({ id, prompt, ...(answer ? { answer } : {}) });

  test('retains a prior answered question the new generation dropped', () => {
    const prior = [q('q_form', 'Which form do you want?', 'Gold bars')];
    const next = [q('q_dealer', 'Which dealer?')];
    const merged = mergePlanQuestions(prior, next);
    // The answered form question survives as context (answered), plus the new one.
    expect(merged.map((m) => m.id)).toEqual(['q_form', 'q_dealer']);
    expect(merged.find((m) => m.id === 'q_form')?.answer).toBe('Gold bars');
  });

  test('the oscillation cannot happen: answers accumulate across rounds', () => {
    // Round 2 answered form, round 3 drops form and asks dealer. Without the
    // merge, form's answer vanished and got re-asked next round.
    let intentQuestions = [q('q_form', 'Which form?', 'Gold bars')];
    // regen emits only a fresh dealer question
    intentQuestions = mergePlanQuestions(intentQuestions, [q('q_dealer', 'Which dealer?')]);
    // user answers dealer
    intentQuestions = intentQuestions.map((m) => (m.id === 'q_dealer' ? { ...m, answer: 'APMEX' } : m));
    // regen emits nothing new
    intentQuestions = mergePlanQuestions(intentQuestions, []);
    const answered = intentQuestions.filter((m) => m.answer);
    expect(answered.map((m) => m.answer).sort()).toEqual(['APMEX', 'Gold bars']);
    // No open questions remain → plan can go ready.
    expect(intentQuestions.some((m) => !m.answer)).toBe(false);
  });

  test('a re-emitted question keeps its carried answer (dedup by normalized prompt)', () => {
    const prior = [q('q_form', 'Which form do you want?', 'Gold bars')];
    // Same prompt, different whitespace/case — must be treated as the same question.
    const next = [{ id: 'q_form', prompt: 'which   FORM do you want?', answer: 'Gold bars' }];
    const merged = mergePlanQuestions(prior, next);
    expect(merged).toHaveLength(1);
    expect(merged[0].answer).toBe('Gold bars');
  });

  test('answered questions sort before open ones', () => {
    const merged = mergePlanQuestions(
      [q('q_a', 'Answered A', 'yes')],
      [q('q_open', 'Open B'), q('q_b', 'Answered B', 'no')],
    );
    expect(merged[merged.length - 1].id).toBe('q_open');
    expect(merged.filter((m) => m.answer)).toHaveLength(2);
  });
});

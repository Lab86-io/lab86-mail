import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  __setAreaClassifierDepsForTest,
  type AreaFactLite,
  areaModelVerdictSchema,
  boundedProfilesForThread,
  type ClassifiableThread,
  classifyThreads,
  extractEmail,
  groundedAssignments,
  LLM_BATCH_CAP,
  MODEL_CONCURRENCY,
  MODEL_PROFILE_CHAR_BUDGET,
  MODEL_PROMPT_CHAR_BUDGET,
  matchThreadToFacts,
  runAreaClassification,
} from '../lib/albatross/area-classifier';
import { AREA_CLASSIFIER_VERSION } from '../lib/albatross/area-home';

const USER = 'user_area_routing_test';

const apiMock = {
  albatross: {
    listAreas: 'albatross.listAreas',
    listUserAreaFacts: 'albatross.listUserAreaFacts',
    unclassifiedThreads: 'albatross.unclassifiedThreads',
    recordAreaVerdicts: 'albatross.recordAreaVerdicts',
  },
};

function fact(overrides: Partial<AreaFactLite> = {}): AreaFactLite {
  return {
    _id: 'fact_cardhunt_domain',
    areaId: 'area_cardhunt',
    kind: 'domain',
    value: 'cardhunt.ai',
    status: 'verified',
    verifiedAt: 1_780_000_000_000,
    confirmationRefs: [
      {
        kind: 'userConfirmation',
        id: 'confirm_cardhunt',
        confirmedAt: 1_780_000_000_000,
        confirmedBy: USER,
      },
    ],
    ...overrides,
  };
}

function thread(overrides: Partial<ClassifiableThread> = {}): ClassifiableThread {
  return {
    providerThreadId: 'thread_banjo',
    accountId: 'account_1',
    messageId: 'message_banjo',
    subject: 'Last call',
    fromAddress: 'Jack from BanjoSkills <jack@banjoskills.com>',
    toAddress: 'Jakob <jakob@example.com>',
    snippet: 'The banjo course closes tonight.',
    bodyText: 'Hey Jakob, enrollment for The Clawhammer Journey closes tonight. Keep practicing banjo.',
    lastDate: 1_784_155_560_000,
    ...overrides,
  };
}

describe('identity routing', () => {
  test('extracts normalized addresses', () => {
    expect(extractEmail('Alice <Alice@CardHunt.ai>')).toBe('alice@cardhunt.ai');
    expect(extractEmail('mailto:bob@example.com')).toBe('bob@example.com');
    expect(extractEmail('No address')).toBeNull();
  });

  test('routes only verified exact identities', () => {
    expect(
      matchThreadToFacts(thread({ fromAddress: 'Andrew <andrew@cardhunt.ai>' }), [fact()]),
    ).toMatchObject({ areaId: 'area_cardhunt', matchType: 'domain', status: 'verified' });
    expect(
      matchThreadToFacts(thread({ fromAddress: 'Andrew <andrew@cardhunt.ai>' }), [
        fact({ status: 'candidate' }),
      ]),
    ).toBeNull();
    expect(
      matchThreadToFacts(thread({ fromAddress: 'Andrew <andrew@cardhunt.ai>' }), [
        fact({ confirmationRefs: [] }),
      ]),
    ).toBeNull();
  });

  test('never treats a shared consumer domain as Area identity', () => {
    expect(
      matchThreadToFacts(thread({ fromAddress: 'someone@gmail.com' }), [fact({ value: 'gmail.com' })]),
    ).toBeNull();
    expect(
      matchThreadToFacts(thread({ fromAddress: 'boss@gmail.com' }), [
        fact({ kind: 'email', value: 'boss@gmail.com' }),
      ]),
    ).toMatchObject({ matchType: 'email' });
  });

  test('never turns a domain-shaped non-identity fact into a deterministic route', () => {
    expect(
      matchThreadToFacts(thread({ fromAddress: 'Andrew <andrew@cardhunt.ai>' }), [
        fact({ kind: 'note', value: 'cardhunt.ai' }),
      ]),
    ).toBeNull();
  });

  test('abstains on equally strong conflicting identities', () => {
    expect(
      matchThreadToFacts(thread({ fromAddress: 'a@shared-company.test' }), [
        fact({ _id: 'f1', areaId: 'area_a', value: 'shared-company.test' }),
        fact({ _id: 'f2', areaId: 'area_b', value: 'shared-company.test' }),
      ]),
    ).toBeNull();
  });

  test('normalizes mailto/email and leading-at domain facts', () => {
    expect(
      matchThreadToFacts(thread({ fromAddress: 'Andrew <andrew@cardhunt.ai>' }), [
        fact({ kind: 'email', value: 'mailto:andrew@cardhunt.ai' }),
      ]),
    ).toMatchObject({ matchType: 'email' });
    expect(
      matchThreadToFacts(thread({ fromAddress: 'Andrew <andrew@cardhunt.ai>' }), [
        fact({ value: '@cardhunt.ai' }),
      ]),
    ).toMatchObject({ matchType: 'domain' });
    expect(
      matchThreadToFacts(thread({ fromAddress: 'Andrew <andrew@cardhunt.ai>' }), [
        fact({ value: 'https://www.cardhunt.ai/about' }),
      ]),
    ).toMatchObject({ matchType: 'domain', matchValue: 'cardhunt.ai' });
    expect(
      matchThreadToFacts(thread({ fromAddress: 'Andrew <andrew@cardhunt.ai>' }), [
        fact({ kind: 'domain', value: 'andrew@cardhunt.ai' }),
      ]),
    ).toBeNull();
  });

  test('an exact email identity outranks a conflicting domain identity', () => {
    expect(
      matchThreadToFacts(thread({ fromAddress: 'andrew@cardhunt.ai' }), [
        fact({ _id: 'domain', areaId: 'area_domain', value: 'cardhunt.ai' }),
        fact({ _id: 'email', areaId: 'area_email', kind: 'email', value: 'andrew@cardhunt.ai' }),
      ]),
    ).toMatchObject({ areaId: 'area_email', matchType: 'email' });
  });
});

describe('classifier prompt budget', () => {
  test('bounds serialized profiles and prioritizes explicit message evidence', () => {
    const profiles = Array.from({ length: 100 }, (_, index) => ({
      id: `area_${index}`,
      name: index === 99 ? 'BanjoSkills' : `Unrelated ${index}`,
      kind: 'work',
      description: 'x'.repeat(500),
      primaryDomain: undefined,
      facts: Array.from({ length: 4 }, (__, factIndex) => ({
        id: `fact_${index}_${factIndex}`,
        kind: 'project',
        value: 'y'.repeat(160),
        status: 'candidate' as const,
      })),
    }));
    const bounded = boundedProfilesForThread(profiles, thread());
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(MODEL_PROFILE_CHAR_BUDGET);
    expect(bounded[0].id).toBe('area_99');
    expect(bounded.length).toBeLessThan(profiles.length);
  });

  test('keeps a thread-relevant fact even when it appears beyond the first ten', () => {
    const profiles = [
      {
        id: 'area_1',
        name: 'Work',
        kind: 'work',
        description: undefined,
        primaryDomain: undefined,
        facts: Array.from({ length: 12 }, (_, index) => ({
          id: index === 11 ? 'fact_relevant' : `fact_${index}`,
          kind: 'project',
          value: index === 11 ? 'Clawhammer Journey' : `unrelated project ${index}`,
          status: 'candidate' as const,
        })),
      },
    ];
    const [bounded] = boundedProfilesForThread(profiles, thread());
    expect(bounded.facts).toHaveLength(10);
    expect(bounded.facts.map((item) => item.id)).toContain('fact_relevant');
  });
});

describe('classification backlog batching', () => {
  const result = (overrides: Partial<Awaited<ReturnType<typeof classifyThreads>>> = {}) => ({
    deterministic: 0,
    modelAssigned: 0,
    noArea: 0,
    failed: 0,
    processed: 0,
    ...overrides,
  });

  test('continues after a full batch and aggregates until a short batch', async () => {
    const batches = [
      result({ processed: LLM_BATCH_CAP, noArea: LLM_BATCH_CAP }),
      result({ processed: 3, modelAssigned: 3 }),
    ];
    let calls = 0;
    const totals = await runAreaClassification({
      userId: USER,
      classify: async () => batches[calls++],
    });
    expect(calls).toBe(2);
    expect(totals).toEqual(result({ processed: LLM_BATCH_CAP + 3, noArea: LLM_BATCH_CAP, modelAssigned: 3 }));
  });

  test('stops immediately when a full batch reports a provider failure', async () => {
    let calls = 0;
    const totals = await runAreaClassification({
      userId: USER,
      classify: async () => {
        calls += 1;
        return result({ processed: LLM_BATCH_CAP, failed: 1, noArea: LLM_BATCH_CAP - 1 });
      },
    });
    expect(calls).toBe(1);
    expect(totals.failed).toBe(1);
  });
});

describe('grounded structured output', () => {
  const activeAreaIds = new Set(['area_cardhunt']);
  const factsById = new Map([['fact_cardhunt_domain', fact()]]);

  test('accepts an active Area only when its evidence occurs in the email', () => {
    const verdict = areaModelVerdictSchema.parse({
      assignments: [
        {
          areaId: 'area_cardhunt',
          evidence: ['The Clawhammer Journey'],
          factIds: ['fact_cardhunt_domain'],
          reason: 'Explicit course context.',
        },
      ],
    });
    expect(groundedAssignments({ verdict, thread: thread(), activeAreaIds, factsById })).toHaveLength(1);
  });

  test('rejects whitespace-only grounding evidence at schema validation', () => {
    expect(() =>
      areaModelVerdictSchema.parse({
        assignments: [{ areaId: 'area_cardhunt', evidence: ['   '], factIds: [], reason: 'Blank evidence.' }],
      }),
    ).toThrow();
  });

  test('drops hallucinated/unknown assignments and dedupes Areas while rejecting cross-Area fact ids', () => {
    const crossAreaFact = fact({ _id: 'fact_other', areaId: 'area_other' });
    const allFacts = new Map([...factsById, ['fact_other', crossAreaFact]]);
    const verdict = areaModelVerdictSchema.parse({
      assignments: [
        {
          areaId: 'area_cardhunt',
          evidence: ['A CardHunt production incident'],
          factIds: [],
          reason: 'Not actually present.',
        },
        {
          areaId: 'area_unknown',
          evidence: ['banjo'],
          factIds: [],
          reason: 'Unknown area.',
        },
        {
          areaId: 'area_cardhunt',
          evidence: ['banjo'],
          factIds: ['fact_cardhunt_domain', 'fact_other'],
          reason: 'First grounded assignment.',
        },
        {
          areaId: 'area_cardhunt',
          evidence: ['Clawhammer Journey'],
          factIds: [],
          reason: 'Duplicate assignment.',
        },
      ],
    });
    expect(groundedAssignments({ verdict, thread: thread(), activeAreaIds, factsById: allFacts })).toEqual([
      {
        areaId: 'area_cardhunt',
        evidence: ['banjo'],
        factIds: ['fact_cardhunt_domain'],
        reason: 'First grounded assignment.',
      },
    ]);
  });
});

describe('sparse classifier orchestration', () => {
  let fixtures: Record<string, any>;
  let mutationCalls: Array<{ fn: string; args: any }>;
  let modelCalls: any[];
  let modelResult: any;

  beforeEach(() => {
    fixtures = {
      [apiMock.albatross.listAreas]: [
        {
          _id: 'area_cardhunt',
          name: 'CardHunt',
          kind: 'job',
          description: 'Software engineering contract role at CardHunt.',
        },
      ],
      'facts:verified': [fact()],
      'facts:candidate': [],
      [apiMock.albatross.unclassifiedThreads]: [],
    };
    mutationCalls = [];
    modelCalls = [];
    modelResult = { assignments: [] };
    __setAreaClassifierDepsForTest({
      api: apiMock as any,
      convexQuery: (async (fn: any, args: any) => {
        if (fn === apiMock.albatross.listUserAreaFacts) return fixtures[`facts:${args.status}`] || [];
        return fixtures[fn] || [];
      }) as any,
      convexMutation: (async (fn: any, args: any) => {
        mutationCalls.push({ fn, args });
        return { classified: args.verdicts?.length || 0 };
      }) as any,
      generateObjectForCurrentUser: (async (options: any) => {
        modelCalls.push(options);
        if (modelResult instanceof Error) throw modelResult;
        if (typeof modelResult === 'function') return await modelResult(options);
        return { object: modelResult };
      }) as any,
    });
  });

  afterAll(() => __setAreaClassifierDepsForTest());

  test('verified exact identity is authoritative and bypasses Area-model judgment', async () => {
    fixtures[apiMock.albatross.unclassifiedThreads] = [
      thread({ fromAddress: 'Andrew <andrew@cardhunt.ai>' }),
    ];
    const result = await classifyThreads({ userId: USER });
    expect(result).toMatchObject({ deterministic: 1, modelAssigned: 0, noArea: 0, failed: 0 });
    expect(modelCalls).toHaveLength(0);
    expect(mutationCalls[0].args.classifierVersion).toBe(AREA_CLASSIFIER_VERSION);
    expect(mutationCalls[0].args.verdicts[0].links[0]).toMatchObject({
      areaId: 'area_cardhunt',
      status: 'verified',
    });
    expect(mutationCalls[0].args.verdicts[0]).toMatchObject({
      accountId: 'account_1',
      messageId: 'message_banjo',
    });
    expect(mutationCalls[0].args.verdicts[0].links[0].confirmationRefs[0]).toMatchObject({
      id: 'confirm_cardhunt',
      confirmedAt: 1_780_000_000_000,
      confirmedBy: USER,
      prompt: 'Inherited from a user-verified Area identity fact',
      sourceRefId: 'fact_cardhunt_domain',
    });
  });

  test('BanjoSkills is a successful no-Area verdict and the model sees the substantive body', async () => {
    fixtures[apiMock.albatross.unclassifiedThreads] = [thread()];
    const result = await classifyThreads({ userId: USER });
    expect(result).toMatchObject({ deterministic: 0, modelAssigned: 0, noArea: 1, failed: 0 });
    expect(modelCalls[0]).toMatchObject({
      feature: 'albatross_area_route',
      speed: 'classify',
      schema: areaModelVerdictSchema,
    });
    expect(modelCalls[0].prompt).toContain('Clawhammer Journey');
    expect(mutationCalls[0].args.verdicts[0].links).toEqual([]);
  });

  test('caps every email field so an oversized message still produces a bounded prompt', async () => {
    fixtures[apiMock.albatross.unclassifiedThreads] = [
      thread({
        subject: 's'.repeat(20_000),
        snippet: 'n'.repeat(20_000),
        bodyText: 'b'.repeat(100_000),
      }),
    ];
    const result = await classifyThreads({ userId: USER });
    expect(result.noArea).toBe(1);
    expect(modelCalls[0].prompt.length).toBeLessThanOrEqual(MODEL_PROMPT_CHAR_BUDGET);
    const payload = JSON.parse(modelCalls[0].prompt);
    expect(payload.email.subject).toHaveLength(500);
    expect(payload.email.snippet).toHaveLength(1_000);
    expect(payload.email.body).toHaveLength(4_000);
  });

  test('a grounded model assignment becomes a replaceable candidate link', async () => {
    fixtures[apiMock.albatross.unclassifiedThreads] = [
      thread({
        subject: 'CardHunt production deploy',
        bodyText: 'The CardHunt production deploy is blocked on the API migration.',
      }),
    ];
    modelResult = {
      assignments: [
        {
          areaId: 'area_cardhunt',
          evidence: ['CardHunt production deploy'],
          factIds: [],
          reason: 'Explicitly concerns CardHunt production.',
        },
      ],
    };
    const result = await classifyThreads({ userId: USER });
    expect(result.modelAssigned).toBe(1);
    expect(mutationCalls[0].args.verdicts[0].links[0]).toMatchObject({
      areaId: 'area_cardhunt',
      status: 'candidate',
      confirmationRefs: [],
    });
  });

  test('ungrounded model evidence is treated as no Area', async () => {
    fixtures[apiMock.albatross.unclassifiedThreads] = [thread()];
    modelResult = {
      assignments: [
        {
          areaId: 'area_cardhunt',
          evidence: ['CardHunt outage'],
          factIds: [],
          reason: 'Hallucinated overlap.',
        },
      ],
    };
    const result = await classifyThreads({ userId: USER });
    expect(result.noArea).toBe(1);
    expect(mutationCalls[0].args.verdicts[0].links).toEqual([]);
  });

  test('model failures stay pending by omitting a persisted verdict', async () => {
    fixtures[apiMock.albatross.unclassifiedThreads] = [thread()];
    modelResult = new Error('provider unavailable');
    const result = await classifyThreads({ userId: USER });
    expect(result.failed).toBe(1);
    expect(mutationCalls).toHaveLength(0);
  });

  test('zero active Areas settles pending threads without spending a model call', async () => {
    fixtures[apiMock.albatross.listAreas] = [];
    fixtures[apiMock.albatross.unclassifiedThreads] = [thread()];
    const result = await classifyThreads({ userId: USER });
    expect(result.noArea).toBe(1);
    expect(modelCalls).toHaveLength(0);
    expect(mutationCalls[0].args.verdicts[0].links).toEqual([]);
  });

  test('bounds concurrent model calls and preserves message association across mixed outcomes', async () => {
    fixtures[apiMock.albatross.unclassifiedThreads] = Array.from({ length: MODEL_CONCURRENCY + 2 }, (_, i) =>
      thread({
        providerThreadId: `thread_${i}`,
        messageId: `message_${i}`,
        subject: `CardHunt evidence ${i}`,
        bodyText: `CardHunt evidence ${i}`,
      }),
    );
    let inFlight = 0;
    let peak = 0;
    modelResult = async (options: any) => {
      const payload = JSON.parse(options.prompt);
      const messageId = String(payload.email.messageId);
      const index = Number(messageId.split('_')[1]);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, (MODEL_CONCURRENCY + 2 - index) * 2));
      inFlight -= 1;
      if (index === 2) throw new Error('one provider failure');
      return {
        object: {
          assignments: [
            {
              areaId: 'area_cardhunt',
              evidence: [`CardHunt evidence ${index}`],
              factIds: [],
              reason: `message ${index}`,
            },
          ],
        },
      };
    };

    const result = await classifyThreads({ userId: USER });
    expect(peak).toBe(MODEL_CONCURRENCY);
    expect(result).toMatchObject({
      processed: MODEL_CONCURRENCY + 2,
      modelAssigned: MODEL_CONCURRENCY + 1,
      failed: 1,
    });
    const persisted = mutationCalls[0].args.verdicts;
    expect(persisted).toHaveLength(MODEL_CONCURRENCY + 1);
    for (const verdict of persisted) {
      const index = Number(verdict.messageId.split('_')[1]);
      expect(verdict.links[0].reason).toBe(`message ${index}`);
    }
    expect(persisted.some((verdict: any) => verdict.messageId === 'message_2')).toBe(false);
  });
});

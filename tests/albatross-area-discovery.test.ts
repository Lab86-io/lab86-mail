import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  __setAreaDiscoveryDepsForTest,
  classifyAreaArtifacts,
  parseAreaDiscoveryOutput,
  prepareAreaDiscoveryContext,
  readAreaDiscoveryContext,
} from '../lib/albatross/area-discovery';

const USER = 'user_area_discovery';
const apiMock = {
  albatross: {
    ensurePersonal: 'albatross.ensurePersonal',
    listAreas: 'albatross.listAreas',
    listUserAreaFacts: 'albatross.listUserAreaFacts',
    unclassifiedAreaArtifacts: 'albatross.unclassifiedAreaArtifacts',
    recordAreaLinks: 'albatross.recordAreaLinks',
    areaDiscoveryBrief: 'albatross.areaDiscoveryBrief',
  },
};

describe('cross-source Area discovery', () => {
  let corpus: any;
  let brief: any;
  let llmText: string;
  let mutationCalls: any[];
  let llmCalls: any[];
  let areasFixture: any[];

  beforeEach(() => {
    corpus = { items: [], sources: ['mail', 'calendar', 'tasks', 'github', 'granola'] };
    brief = { candidates: [], candidateFacts: [] };
    llmText = '[]';
    mutationCalls = [];
    llmCalls = [];
    areasFixture = [
      {
        _id: 'area_albatross',
        name: 'Albatross',
        kind: 'project',
        description: 'Personal operating system and mail workspace',
        primaryDomain: 'lab86.ai',
      },
    ];
    __setAreaDiscoveryDepsForTest({
      api: apiMock as any,
      convexQuery: (async (fn: string, args: any) => {
        if (fn === apiMock.albatross.listAreas) {
          return areasFixture;
        }
        if (fn === apiMock.albatross.listUserAreaFacts) {
          return args.status === 'verified'
            ? [
                {
                  _id: 'fact_repo',
                  areaId: 'area_albatross',
                  kind: 'repository',
                  value: 'Lab86-io/lab86-mail',
                  status: 'verified',
                },
              ]
            : [];
        }
        if (fn === apiMock.albatross.unclassifiedAreaArtifacts) return corpus;
        if (fn === apiMock.albatross.areaDiscoveryBrief) return brief;
        throw new Error(`Unexpected query ${fn}`);
      }) as any,
      convexMutation: (async (fn: string, args: any) => {
        // The Personal-area ensure is bookkeeping, not a link write — keep it
        // out of mutationCalls so assertions read link writes positionally.
        if (fn === apiMock.albatross.ensurePersonal) return { areaId: 'area_personal' };
        mutationCalls.push({ fn, args });
        return { inserted: args.links.length, skipped: 0 };
      }) as any,
      generateTextForCurrentUser: (async (options: any) => {
        llmCalls.push(options);
        return { text: llmText } as any;
      }) as any,
    });
  });

  afterAll(() => __setAreaDiscoveryDepsForTest());

  test('uses repository context to claim indirect GitHub evidence as a candidate', async () => {
    corpus.items = [
      {
        artifactKind: 'mcpItem',
        artifactId: 'github:pull_request:42',
        externalId: 'pull_request:42',
        source: 'github',
        title: 'Fix area context discovery',
        text: 'GitHub notification Lab86-io/lab86-mail pull request #42 merged by dependabot',
        occurredAt: 1_780_000_000_000,
      },
    ];

    const result = await classifyAreaArtifacts({ userId: USER });

    expect(result).toMatchObject({ deterministic: 1, llm: 0, skipped: 0 });
    expect(llmCalls).toHaveLength(0);
    expect(mutationCalls[0]?.args.links[0]).toMatchObject({
      areaId: 'area_albatross',
      artifactKind: 'mcpItem',
      artifactId: 'github:pull_request:42',
      externalId: 'pull_request:42',
      status: 'candidate',
    });
    expect(mutationCalls[0]?.args.links[0].sourceRefs[0].label).toContain('github');
  });

  test('uses one bounded agentic pass for semantic evidence but never silently verifies it', async () => {
    corpus.items = [
      {
        artifactKind: 'mcpItem',
        artifactId: 'granola:meeting:7',
        source: 'granola',
        title: 'Weekly product sync',
        text: 'Discussed rollout risks, onboarding feedback, and the next customer milestone.',
        occurredAt: 1_780_000_000_000,
      },
    ];
    llmText = JSON.stringify([
      {
        candidateId: 'mcpItem:-:granola:meeting:7',
        areaName: 'Albatross',
        confidence: 'high',
        reason: 'meeting discussed the Area product and migration',
      },
    ]);

    const result = await classifyAreaArtifacts({ userId: USER });

    expect(result).toMatchObject({ deterministic: 0, llm: 1, skipped: 0 });
    expect(llmCalls).toHaveLength(1);
    expect(mutationCalls[0]?.args.links[0]).toMatchObject({
      artifactKind: 'mcpItem',
      status: 'candidate',
      confidence: 0.62,
    });
  });

  test('routes broad description overlap through the conservative agentic pass', async () => {
    corpus.items = [
      {
        artifactKind: 'mcpItem',
        artifactId: 'granola:meeting:description-only',
        source: 'granola',
        title: 'Workspace review',
        text: 'Personal operating system and mail workspace planning.',
        occurredAt: 1_780_000_000_000,
      },
    ];

    const result = await classifyAreaArtifacts({ userId: USER });

    expect(result).toMatchObject({ deterministic: 0, llm: 0, skipped: 1 });
    expect(llmCalls).toHaveLength(1);
    expect(mutationCalls).toHaveLength(0);
  });

  test('never reassigns an artifact to an Area the user already rejected', async () => {
    corpus.items = [
      {
        artifactKind: 'mcpItem',
        artifactId: 'github:pull_request:rejected',
        source: 'github',
        title: 'Lab86 change',
        text: 'Lab86-io/lab86-mail pull request',
        occurredAt: 1_780_000_000_000,
        rejectedAreaIds: ['area_albatross'],
      },
    ];

    const result = await classifyAreaArtifacts({ userId: USER });

    expect(result).toMatchObject({ deterministic: 0, llm: 0, skipped: 1 });
    expect(llmCalls).toHaveLength(0);
    expect(mutationCalls).toHaveLength(0);
  });

  test('mail and calendar the model cannot place fall back to Personal instead of limbo', async () => {
    corpus.items = [
      {
        artifactKind: 'mailThread',
        artifactId: 'thread_unsure',
        accountId: 'acct_1',
        source: 'mail',
        title: 'Receipt from a one-off store',
        text: 'Order confirmation 8841',
        occurredAt: 1_780_000_000_000,
      },
      {
        artifactKind: 'calendarEvent',
        artifactId: 'event_unsure',
        accountId: 'acct_1',
        source: 'calendar',
        title: 'Untitled block',
        text: 'Untitled block',
        occurredAt: 1_780_000_000_000,
      },
      {
        artifactKind: 'mcpItem',
        artifactId: 'github:issue:9',
        source: 'github',
        title: 'Unrelated issue',
        text: 'Some other repository entirely',
        occurredAt: 1_780_000_000_000,
      },
    ];
    llmText = JSON.stringify([
      { candidateId: 'mailThread:acct_1:thread_unsure', areaName: null, confidence: 'low' },
      { candidateId: 'calendarEvent:acct_1:event_unsure', areaName: 'Not An Area', confidence: 'high' },
      { candidateId: 'mcpItem:-:github:issue:9', areaName: null, confidence: 'low' },
    ]);

    const result = await classifyAreaArtifacts({ userId: USER });

    // Mail + calendar settle in Personal; connector items stay unclaimed.
    expect(result).toMatchObject({ deterministic: 0, llm: 0, personal: 2, skipped: 1 });
    const links = mutationCalls[0]?.args.links;
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toMatchObject({
        areaId: 'area_personal',
        role: 'secondary',
        status: 'candidate',
      });
      expect(link.confidence).toBeLessThan(0.5);
    }
    expect(links.map((link: any) => link.artifactId).sort()).toEqual(['event_unsure', 'thread_unsure']);
  });

  test('the Personal fallback never applies to an area-scoped Teach pass', async () => {
    corpus.items = [
      {
        artifactKind: 'mailThread',
        artifactId: 'thread_scoped',
        accountId: 'acct_1',
        source: 'mail',
        title: 'Receipt',
        text: 'Order confirmation',
        occurredAt: 1_780_000_000_000,
      },
    ];
    llmText = JSON.stringify([
      { candidateId: 'mailThread:acct_1:thread_scoped', areaName: null, confidence: 'low' },
    ]);

    const result = await classifyAreaArtifacts({ userId: USER, areaId: 'area_albatross' });

    expect(result).toMatchObject({ personal: 0, skipped: 1 });
    expect(mutationCalls).toHaveLength(0);
  });

  test('an artifact the user rejected from Personal is never re-filed there', async () => {
    corpus.items = [
      {
        artifactKind: 'mailThread',
        artifactId: 'thread_rejected_personal',
        accountId: 'acct_1',
        source: 'mail',
        title: 'Receipt',
        text: 'Order confirmation',
        occurredAt: 1_780_000_000_000,
      },
    ];
    corpus.items[0].rejectedAreaIds = ['area_personal'];
    llmText = JSON.stringify([
      { candidateId: 'mailThread:acct_1:thread_rejected_personal', areaName: null, confidence: 'low' },
    ]);

    const result = await classifyAreaArtifacts({ userId: USER });

    expect(result).toMatchObject({ personal: 0, skipped: 1 });
    expect(mutationCalls).toHaveLength(0);
  });

  test('Personal is never a full-sweep candidate: a Personal verdict lands as the secondary fallback', async () => {
    areasFixture = [
      ...areasFixture,
      { _id: 'area_personal', name: 'Personal', kind: 'personal', description: 'Catch-all context' },
    ];
    corpus.items = [
      {
        artifactKind: 'mailThread',
        artifactId: 'thread_personalish',
        accountId: 'acct_1',
        source: 'mail',
        title: 'Dentist reminder',
        text: 'Your appointment is confirmed',
        occurredAt: 1_780_000_000_000,
      },
    ];
    llmText = JSON.stringify([
      { candidateId: 'mailThread:acct_1:thread_personalish', areaName: 'Personal', confidence: 'high' },
    ]);

    const result = await classifyAreaArtifacts({ userId: USER });

    expect(result).toMatchObject({ deterministic: 0, llm: 0, personal: 1, skipped: 0 });
    // Personal never appears as a candidate area entry in the sweep prompt
    // (the word may still occur inside another area's description).
    expect(llmCalls[0].prompt.split('## Recent unclaimed evidence')[0]).not.toContain('- Personal (');
    expect(mutationCalls[0]?.args.links[0]).toMatchObject({
      areaId: 'area_personal',
      role: 'secondary',
      status: 'candidate',
    });
  });

  test('with Personal as the only area, eligible artifacts file straight there without a model call', async () => {
    areasFixture = [{ _id: 'area_personal', name: 'Personal', kind: 'personal' }];
    corpus.items = [
      {
        artifactKind: 'mailThread',
        artifactId: 'thread_only_personal',
        accountId: 'acct_1',
        source: 'mail',
        title: 'Receipt',
        text: 'Order confirmation',
        occurredAt: 1_780_000_000_000,
      },
      {
        artifactKind: 'task',
        artifactId: 'card_1',
        source: 'tasks',
        title: 'Water plants',
        text: 'Water plants',
        occurredAt: 1_780_000_000_000,
      },
    ];

    const result = await classifyAreaArtifacts({ userId: USER });

    expect(result).toMatchObject({ deterministic: 0, llm: 0, personal: 1, skipped: 1 });
    expect(llmCalls).toHaveLength(0);
    expect(mutationCalls[0]?.args.links).toHaveLength(1);
    expect(mutationCalls[0]?.args.links[0]).toMatchObject({
      areaId: 'area_personal',
      artifactId: 'thread_only_personal',
      role: 'secondary',
    });
  });

  test('an area-scoped Teach pass on Personal itself still classifies normally', async () => {
    areasFixture = [
      ...areasFixture,
      { _id: 'area_personal', name: 'Personal', kind: 'personal', description: 'Catch-all context' },
    ];
    corpus.items = [
      {
        artifactKind: 'mailThread',
        artifactId: 'thread_teach_personal',
        accountId: 'acct_1',
        source: 'mail',
        title: 'Dentist reminder',
        text: 'Your appointment is confirmed',
        occurredAt: 1_780_000_000_000,
      },
    ];
    llmText = JSON.stringify([
      { candidateId: 'mailThread:acct_1:thread_teach_personal', areaName: 'Personal', confidence: 'high' },
    ]);

    const result = await classifyAreaArtifacts({ userId: USER, areaId: 'area_personal' });

    expect(result).toMatchObject({ deterministic: 0, llm: 1, personal: 0, skipped: 0 });
    expect(mutationCalls[0]?.args.links[0]).toMatchObject({
      areaId: 'area_personal',
      status: 'candidate',
      confidence: 0.62,
    });
  });

  test('injects connected sources and a focused confirmation instruction into Teach', async () => {
    brief = {
      candidates: [
        {
          areaName: 'Albatross',
          source: 'github',
          title: 'PR #42 merged',
          reason: 'repository match',
        },
      ],
      candidateFacts: [],
    };

    const context = await prepareAreaDiscoveryContext({ userId: USER, areaId: 'area_albatross' });

    expect(context.systemContext).toContain('mail, calendar, tasks, github, granola');
    expect(context.systemContext).toContain('Albatross ↔ github: PR #42 merged');
    expect(context.systemContext).toContain('ask one focused confirmation question');
  });

  test('reads precomputed Teach context without running classification on the chat path', async () => {
    brief = {
      candidates: [{ areaName: 'Albatross', source: 'github', title: 'PR #42', reason: 'repository match' }],
      candidateFacts: [],
    };

    const context = await readAreaDiscoveryContext({ userId: USER, areaId: 'area_albatross' });

    expect(context.sources).toEqual(['mail', 'calendar', 'tasks', 'github', 'granola']);
    expect(context.systemContext).toContain('Albatross ↔ github: PR #42');
    expect(llmCalls).toHaveLength(0);
    expect(mutationCalls).toHaveLength(0);
  });
});

describe('Area discovery model output', () => {
  test('keeps valid verdicts and rejects malformed output', () => {
    expect(
      parseAreaDiscoveryOutput(
        '```json\n[{"candidateId":"mcpItem:-:1","areaName":"Albatross","confidence":"high"}]\n```',
      ),
    ).toHaveLength(1);
    expect(parseAreaDiscoveryOutput('not json')).toEqual([]);
  });
});

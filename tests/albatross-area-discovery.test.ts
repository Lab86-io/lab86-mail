import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  __setAreaDiscoveryDepsForTest,
  classifyAreaArtifacts,
  parseAreaDiscoveryOutput,
  prepareAreaDiscoveryContext,
} from '../lib/albatross/area-discovery';

const USER = 'user_area_discovery';
const apiMock = {
  albatross: {
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

  beforeEach(() => {
    corpus = { items: [], sources: ['mail', 'calendar', 'tasks', 'github', 'granola'] };
    brief = { candidates: [], candidateFacts: [] };
    llmText = '[]';
    mutationCalls = [];
    llmCalls = [];
    __setAreaDiscoveryDepsForTest({
      api: apiMock as any,
      convexQuery: (async (fn: string, args: any) => {
        if (fn === apiMock.albatross.listAreas) {
          return [
            {
              _id: 'area_albatross',
              name: 'Albatross',
              kind: 'project',
              description: 'Personal operating system and mail workspace',
              primaryDomain: 'lab86.ai',
            },
          ];
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

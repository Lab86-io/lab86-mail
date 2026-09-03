import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { AGENT_TOOL_NAMES } from '../lib/ai/loop';
import { resolveWorkByTitle, titleMatchScore } from '../lib/albatross/work-title-match';
import {
  harvestTurnArtifacts,
  isShapeWrite,
  reconcileWorkTurn,
  setWorkTurnReconcileDependenciesForTest,
} from '../lib/albatross/work-turn-reconcile';
import { TOOLS } from '../lib/tools';
import * as albatross from '../lib/tools/albatross';
import { runTool } from './tools/harness';

const apiMock = {
  albatrossWorkV2: {
    workDetail: 'albatrossWorkV2.workDetail',
    allWork: 'albatrossWorkV2.allWork',
    addListItem: 'albatrossWorkV2.addListItem',
    logMetric: 'albatrossWorkV2.logMetric',
    setAgentState: 'albatrossWorkV2.setAgentState',
  },
};

const rows = [
  {
    _id: 'work_movies',
    title: 'Movie list',
    shape: 'list',
    workState: 'active',
    rawText: 'Movie list: Heat',
  },
  { _id: 'work_books', title: 'Books to read', shape: 'list', workState: 'active', rawText: 'Books' },
  { _id: 'work_weight', title: 'Lose fifteen pounds', shape: 'practice', workState: 'active', rawText: 'w' },
  { _id: 'work_old', title: 'Movie list', shape: 'list', workState: 'done', rawText: 'old' },
  { _id: 'work_project', title: 'Movie night project', shape: 'project', workState: 'active', rawText: 'p' },
];

const mutations: Array<{ fn: string; args: any }> = [];

beforeEach(() => {
  mutations.length = 0;
  albatross.__setAlbatrossToolDepsForTest({
    api: apiMock as any,
    convexQuery: (async (fn: string, args: any) => {
      if (fn === apiMock.albatrossWorkV2.allWork) return rows;
      if (fn === apiMock.albatrossWorkV2.workDetail) {
        const row = rows.find((entry) => entry._id === args.workId);
        return row ? { work: row } : null;
      }
      throw new Error(`unexpected query ${fn}`);
    }) as any,
    convexMutation: (async (fn: string, args: any) => {
      mutations.push({ fn, args });
      if (fn === apiMock.albatrossWorkV2.addListItem) {
        return {
          item: { id: 'li_new', text: args.text, done: false, addedAt: 100 },
          listItems: [{ id: 'li_1' }, { id: 'li_new' }],
        };
      }
      if (fn === apiMock.albatrossWorkV2.logMetric) {
        return {
          entry: { _id: 'me_1', at: args.at ?? 200, value: args.value, note: args.note ?? null },
          metric: { name: 'weight', unit: 'lb', direction: 'down' },
          summary: { latest: args.value, latestAt: 200, count: 3, weeksWithEntry: 2 },
        };
      }
      return null;
    }) as any,
  });
});

afterAll(() => {
  albatross.__setAlbatrossToolDepsForTest();
});

describe('resolveWorkByTitle', () => {
  test('scores exact, containment, and shared words', () => {
    expect(titleMatchScore(rows[0], 'Movie list')).toBe(1);
    expect(titleMatchScore(rows[0], 'the movie list')).toBeGreaterThanOrEqual(0.9);
    expect(titleMatchScore(rows[1], 'my books')).toBeGreaterThan(0.4);
    expect(titleMatchScore(rows[1], 'passport')).toBe(0);
    expect(titleMatchScore({ _id: 'x', rawText: 'Gift ideas: socks' }, 'gift ideas')).toBeGreaterThan(0.8);
  });

  test('prefers open Work of the wanted shape, and gives up on a tie', () => {
    expect(resolveWorkByTitle(rows, 'movie list', { shape: 'list' })?._id).toBe('work_movies');
    expect(resolveWorkByTitle(rows, 'movies', { shape: 'list' })?._id).toBe('work_movies');
    expect(resolveWorkByTitle(rows, 'fifteen pounds', { shape: 'list' })).toBeNull();
    expect(resolveWorkByTitle(rows, 'fifteen pounds')?._id).toBe('work_weight');
    expect(resolveWorkByTitle(rows, 'weight')).toBeNull();
    const tie = [
      { _id: 'a', title: 'Trip ideas', shape: 'list' },
      { _id: 'b', title: 'Gift ideas', shape: 'list' },
    ];
    expect(resolveWorkByTitle(tie, 'ideas')).toBeNull();
    expect(resolveWorkByTitle(tie, 'trip ideas')?._id).toBe('a');
  });
});

describe('albatross_list_add', () => {
  test('resolves the list by title and adds the item', async () => {
    const result = await runTool(albatross.albatrossListAdd.handler, {
      workTitle: 'the movie list',
      text: 'Blade Runner',
    });
    expect(result).toEqual({
      ok: true,
      workId: 'work_movies',
      workTitle: 'Movie list',
      item: { id: 'li_new', text: 'Blade Runner', done: false, addedAt: 100 },
      itemCount: 2,
      summary: 'Added "Blade Runner" to Movie list.',
    });
    expect(mutations).toEqual([
      {
        fn: apiMock.albatrossWorkV2.addListItem,
        args: { userId: 'test_user_tools', workId: 'work_movies', text: 'Blade Runner' },
      },
    ]);
  });

  test('accepts a workId directly', async () => {
    const result = await runTool(albatross.albatrossListAdd.handler, { workId: 'work_books', text: 'Dune' });
    expect(result.workTitle).toBe('Books to read');
    expect(mutations[0].args.workId).toBe('work_books');
  });

  test('fails plainly when no list matches or the Work is missing', async () => {
    await expect(
      runTool(albatross.albatrossListAdd.handler, { workTitle: 'passport', text: 'x' }),
    ).rejects.toThrow(/No list matches "passport"/);
    await expect(runTool(albatross.albatrossListAdd.handler, { workId: 'nope', text: 'x' })).rejects.toThrow(
      /Work not found/,
    );
    expect(mutations).toEqual([]);
  });

  test('the input schema needs workId or workTitle', () => {
    expect(albatross.albatrossListAdd.input.safeParse({ text: 'x' }).success).toBe(false);
    expect(albatross.albatrossListAdd.input.safeParse({ workTitle: 'movies', text: 'x' }).success).toBe(true);
  });
});

describe('albatross_metric_log', () => {
  test('resolves the practice by title and logs the value', async () => {
    const result = await runTool(albatross.albatrossMetricLog.handler, {
      workTitle: 'fifteen pounds',
      value: 182.4,
      note: 'morning',
      atIso: '2026-09-01T07:00:00.000Z',
    });
    expect(result).toEqual({
      ok: true,
      workId: 'work_weight',
      workTitle: 'Lose fifteen pounds',
      entry: { id: 'me_1', value: 182.4, at: Date.parse('2026-09-01T07:00:00.000Z'), note: 'morning' },
      metric: { name: 'weight', unit: 'lb', direction: 'down' },
      summary: 'Logged 182.4 lb for Lose fifteen pounds.',
    });
    expect(mutations[0].args).toEqual({
      userId: 'test_user_tools',
      workId: 'work_weight',
      value: 182.4,
      at: Date.parse('2026-09-01T07:00:00.000Z'),
      note: 'morning',
    });
  });

  test('a title with no practice falls back to any open Work by title', async () => {
    const result = await runTool(albatross.albatrossMetricLog.handler, {
      workTitle: 'movie night',
      value: 1,
    });
    expect(result.workId).toBe('work_project');
  });
});

describe('registration', () => {
  test('both tools are registered and allowed in the agent loop', () => {
    expect(TOOLS.albatross_list_add?.name).toBe('albatross_list_add');
    expect(TOOLS.albatross_metric_log?.name).toBe('albatross_metric_log');
    expect(AGENT_TOOL_NAMES.has('albatross_list_add')).toBe(true);
    expect(AGENT_TOOL_NAMES.has('albatross_metric_log')).toBe(true);
  });
});

describe('the turn reconcile harvests shape writes', () => {
  const calls = [
    {
      toolName: 'albatross_list_add',
      input: { workTitle: 'movie list', text: 'Blade Runner' },
      output: { ok: true, workId: 'work_movies', item: { id: 'li_new', text: 'Blade Runner' } },
      ok: true,
    },
    {
      toolName: 'albatross_metric_log',
      input: { workTitle: 'weight', value: 182.4 },
      output: {
        ok: true,
        workId: 'work_weight',
        entry: { id: 'me_1' },
        summary: 'Logged 182.4 lb for Weight.',
      },
      ok: true,
    },
    { toolName: 'albatross_list_add', input: { text: 'x' }, output: { ok: false }, ok: false },
  ];

  test('harvestTurnArtifacts names them as chat artifacts on their Work', () => {
    const artifacts = harvestTurnArtifacts(calls);
    expect(artifacts).toEqual([
      { kind: 'listItem', id: 'li_new', title: 'Blade Runner', sourceKind: 'chat', workId: 'work_movies' },
      {
        kind: 'metricEntry',
        id: 'me_1',
        title: 'Logged 182.4 lb for Weight.',
        sourceKind: 'chat',
        workId: 'work_weight',
      },
    ]);
    expect(artifacts.every(isShapeWrite)).toBe(true);
    expect(isShapeWrite({ kind: 'task', id: 't', title: 'T', sourceKind: 'task' })).toBe(false);
  });

  test('reconcileWorkTurn counts them and never writes proof or replans for them', async () => {
    const writes: string[] = [];
    let advanced = 0;
    const restore = setWorkTurnReconcileDependenciesForTest({
      convexQuery: (async () => ({ work: { workState: 'active', shape: 'list' }, questions: [] })) as any,
      convexMutation: (async (fn: any) => {
        writes.push(String(fn?.name ?? fn));
        return null;
      }) as any,
      advanceWork: (async () => {
        advanced += 1;
        return { status: 'ready' } as any;
      }) as any,
      reportError: () => undefined,
    });
    try {
      const result = await reconcileWorkTurn({
        userId: 'u',
        workId: 'work_movies',
        steps: [
          {
            content: [
              { type: 'tool-call', toolCallId: 'c1', toolName: 'albatross_list_add', input: calls[0].input },
              { type: 'tool-result', toolCallId: 'c1', output: calls[0].output },
            ],
          },
        ],
        uiMessages: [],
      });
      expect(result).toEqual({ status: 'ok', artifactsRecorded: 1, questionsAnswered: 0, advanced: false });
      expect(writes).toEqual([]);
      expect(advanced).toBe(0);
    } finally {
      restore();
    }
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { createDailyReportPost } from '../app/api/cron/daily-report/route';
import { createStepWatchPost } from '../app/api/cron/step-watch/route';
import { createStandingOrdersRoute } from '../app/api/standing-orders/route';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import {
  APPROVAL_GATED_TOOLS,
  APPROVAL_RISKS,
  approvalConditionMet,
  approvalSummary,
  TOOL_RISKS,
} from '../lib/ai/approval';
import { runWithAiRequestContext } from '../lib/ai/context';
import * as gateway from '../lib/ai/gateway';
import { AGENT_TOOL_NAMES, liftToolsForAgent, pausedToolResult, runAgent } from '../lib/ai/loop';
import {
  buildStandingOrders,
  isStandingOrderPaused,
  listStandingOrders,
  loadStandingOrderSwitches,
  normalizeStandingOrderSwitches,
  pausedAssistantRisks,
  resetStandingOrderCacheForTest,
  type StandingOrderDependencies,
  StandingOrderError,
  type StandingOrderSources,
  type StandingOrderSwitches,
  setStandingOrderPaused,
  standingOrderDefaults,
} from '../lib/hosted/standing-orders';
import * as narrative from '../lib/narrative/service';
import type { SmartRule } from '../lib/shared/types';
import { kvGet, kvUpsert } from '../lib/store/kv';
import * as memories from '../lib/store/memories';
import { TOOLS } from '../lib/tools';
import { toolRisk } from '../lib/tools/registry';

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  resetStandingOrderCacheForTest();
});

const NONE: StandingOrderSwitches = normalizeStandingOrderSwitches(null);

function rule(overrides: Partial<SmartRule> = {}): SmartRule {
  return {
    _id: 'r1',
    name: 'Newsletters',
    enabled: true,
    scope: 'sender',
    match: 'news@example.test',
    effect: 'always_noise',
    source: 'settings',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function sources(overrides: Partial<StandingOrderSources> = {}): StandingOrderSources {
  return {
    switches: NONE,
    routines: [],
    watches: [],
    rules: [],
    sortingEnabled: true,
    prepareEnabled: true,
    codeCleanupEnabled: false,
    ...overrides,
  };
}

describe('tool risk classes', () => {
  test('every mutating tool declares its risk class in the registry', () => {
    const missing = Object.values(TOOLS)
      .filter((tool) => tool.mutating && !tool.risk)
      .map((tool) => tool.name);
    expect(missing).toEqual([]);
    for (const tool of Object.values(TOOLS)) {
      expect(TOOL_RISKS).toContain(toolRisk(tool));
      // A read-only tool never claims to change anything, and a mutating tool never claims to read.
      expect(toolRisk(tool) === 'read').toBe(!tool.mutating);
    }
  });

  test('the client-safe gated list is exactly the agent tools in an approval class', () => {
    const fromRegistry = Object.values(TOOLS)
      .filter((tool) => AGENT_TOOL_NAMES.has(tool.name) && APPROVAL_RISKS.has(toolRisk(tool)))
      .map((tool) => tool.name)
      .sort();
    expect([...APPROVAL_GATED_TOOLS].sort()).toEqual(fromRegistry);
  });

  test('sending, inviting, and deleting for good are never write_self', () => {
    for (const name of [
      'send_message',
      'reply',
      'reply_all',
      'forward',
      'schedule_send',
      'calendar_rsvp_event',
    ])
      expect(toolRisk(TOOLS[name])).toBe('reach_person');
    for (const name of ['tasks_delete_board', 'tasks_delete_column', 'forget', 'delete_draft'])
      expect(toolRisk(TOOLS[name])).toBe('destructive');
    for (const name of ['archive_thread', 'trash_thread', 'tasks_delete_card', 'save_draft'])
      expect(toolRisk(TOOLS[name])).toBe('write_self');
    expect(toolRisk({ mutating: true })).toBe('write_self');
    expect(toolRisk({ mutating: false })).toBe('read');
  });

  test('every gated tool has its own plain approval card', () => {
    for (const name of APPROVAL_GATED_TOOLS) {
      const summary = approvalSummary(name, { column: 'Later', email: 'sam@example.test', status: 'yes' });
      expect(summary.title).not.toBe('Approve this action');
      expect(`${summary.title} ${summary.description ?? ''}`).not.toMatch(/\bAI\b/);
      if (toolRisk(TOOLS[name]) === 'destructive') expect(summary.intent).toBe('destructive');
    }
    expect(approvalSummary('calendar_rsvp_event', { status: 'maybe' }).title).toBe(
      'Answer the invitation: Maybe',
    );
    expect(approvalSummary('calendar_rsvp_event', {}).title).toBe('Answer the invitation');
    expect(approvalSummary('tasks_delete_column', {}).title).toBe('Delete the column');
    expect(approvalSummary('calendar_unsubscribe_calendar', { name: 'Holidays' }).title).toBe(
      'Remove the calendar “Holidays”',
    );
    expect(approvalSummary('forget', {}).title).toBe('Forget what Albatross knows about this person');
    expect(approvalConditionMet('tasks_delete_board', {})).toBe(true);
    expect(approvalConditionMet('calendar_delete_event', {})).toBe(false);
  });

  test('destructive agent tools stop for approval', () => {
    const lifted = liftToolsForAgent('batch', 'UTC');
    for (const name of ['tasks_delete_board', 'forget', 'delete_draft', 'cancel_scheduled'])
      expect(typeof lifted[name].needsApproval).toBe('function');
    expect(lifted.tasks_delete_board.needsApproval({ boardId: 'b' }, {})).toBe(true);
    // Malformed input skips the gate so the model gets its field errors first.
    expect(lifted.tasks_delete_board.needsApproval({}, {})).toBe(false);
  });

  test('a paused class runs nothing and never asks', async () => {
    const archive = spyOn(TOOLS.archive_thread, 'handler').mockResolvedValue({ ok: true } as any);
    const board = spyOn(TOOLS.tasks_delete_board, 'handler').mockResolvedValue({ ok: true } as any);
    restores.push(
      () => archive.mockRestore(),
      () => board.mockRestore(),
    );
    const lifted = liftToolsForAgent('batch', 'UTC', undefined, {
      pausedRisks: new Set(['write_self', 'destructive'] as const),
    });
    expect(lifted.tasks_delete_board.needsApproval).toBeUndefined();
    expect(await lifted.archive_thread.execute({ account: 'a', threadId: 't' }, {})).toEqual(
      pausedToolResult('archive_thread', 'write_self'),
    );
    expect(await lifted.tasks_delete_board.execute({ boardId: 'b' }, {})).toMatchObject({
      ok: false,
      status: 'paused_by_user',
      risk: 'destructive',
    });
    expect(archive).not.toHaveBeenCalled();
    expect(board).not.toHaveBeenCalled();
    // Reads are never paused; reach_person is not paused here, so it still asks.
    expect(typeof lifted.schedule_send.needsApproval).toBe('function');
    expect(pausedToolResult('x', 'write_self').message).not.toMatch(/\bAI\b/);
  });
});

function finish(reason: 'stop' | 'tool-calls' = 'stop'): LanguageModelV3StreamPart {
  return {
    type: 'finish',
    finishReason: { unified: reason, raw: reason },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    },
  };
}

describe('the agent reads the standing orders', () => {
  test('a user who paused write_self gets a refusal, not an archive', async () => {
    const userId = 'orders_agent_user';
    await runWithAiRequestContext({ userId, agent: 'user' }, () =>
      kvUpsert('standingOrders', 'default', { paused: { 'risk:write_self': true } }),
    );
    let turn = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            const parts: LanguageModelV3StreamPart[] =
              turn++ === 0
                ? [
                    {
                      type: 'tool-call',
                      toolCallId: 'a1',
                      toolName: 'archive_thread',
                      input: JSON.stringify({ account: 'acct', threadId: 't1' }),
                    },
                    finish('tool-calls'),
                  ]
                : [
                    { type: 'text-start', id: 't' },
                    { type: 'text-delta', id: 't', delta: 'Paused.' },
                    { type: 'text-end', id: 't' },
                    finish(),
                  ];
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      }),
    });
    const spies = [
      spyOn(gateway, 'resolveAgentRuntimes').mockResolvedValue([
        { userId, source: 'lab86', provider: 'openai', modelName: 'm', model },
      ] as any),
      spyOn(gateway, 'recordAgentUsage').mockResolvedValue(undefined),
      spyOn(gateway, 'hasPlatformAi').mockReturnValue(true),
      spyOn(narrative, 'narrativePrompt').mockResolvedValue(''),
      spyOn(memories, 'listMemories').mockResolvedValue([]),
      spyOn(TOOLS.archive_thread, 'handler').mockResolvedValue({ ok: true } as any),
    ];
    for (const spy of spies) restores.push(() => spy.mockRestore());
    const agent = await runAgent({
      runId: 'orders-run',
      userId,
      messages: [{ role: 'user', content: 'Archive that.' }],
    });
    const events = (await agent.toUIMessageStreamResponse().text())
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)));
    expect(spies[5]).not.toHaveBeenCalled();
    const output = events.find(
      (event) => event.type === 'tool-output-available' && event.toolCallId === 'a1',
    );
    expect(output.output).toMatchObject({ status: 'paused_by_user', risk: 'write_self' });
    expect(events.some((event) => event.type === 'tool-approval-request')).toBe(false);
  });
});

describe('the standing orders list', () => {
  test('it lists the schedule, the mail automations, and the assistant classes', () => {
    const orders = buildStandingOrders(
      sources({
        routines: [
          {
            id: 'rt1',
            title: 'Stretch',
            kind: 'task',
            cadence: 'weekdays',
            daysOfWeek: null,
            localTime: '08:00',
            timezone: 'UTC',
            paused: false,
            nextRunAt: 1,
            projectTitle: 'Health',
          },
        ],
        rules: [rule()],
        watches: [
          { workId: 'w1', title: 'Venue deposit', kind: 'reply', waitingOn: ['maya@example.test'] },
          { workId: 'w2', title: 'Passport', kind: 'step', waitingOn: [] },
        ],
        switches: { ...NONE, 'risk:destructive': true },
      }),
    );
    expect(orders.map((order) => order.id)).toEqual([
      'brief',
      'routine:rt1',
      'sorting',
      'rule:r1',
      'watches',
      'prepare',
      'code_cleanup',
      'risk:read',
      'risk:write_self',
      'risk:reach_person',
      'risk:destructive',
    ]);
    const byId = new Map(orders.map((order) => [order.id, order]));
    expect(byId.get('routine:rt1')?.detail).toBe('Every weekday at 08:00, adds a task for Health.');
    expect(byId.get('rule:r1')?.detail).toBe('Files mail from news@example.test under Noise.');
    expect(byId.get('watches')?.detail).toContain('2 Albatrosses wait');
    expect(byId.get('watches')?.items).toEqual([
      { id: 'w1', label: 'Venue deposit', detail: 'Waits for a reply from maya@example.test' },
      { id: 'w2', label: 'Passport', detail: 'Waits for a confirmation' },
    ]);
    expect(byId.get('code_cleanup')?.paused).toBe(true);
    expect(byId.get('prepare')?.mode).toBe('draft');
    expect(byId.get('risk:read')).toMatchObject({ locked: true, paused: false });
    expect(byId.get('risk:destructive')).toMatchObject({ paused: true, mode: 'asks_first' });
    for (const order of orders) expect(`${order.title} ${order.detail}`).not.toMatch(/\bAI\b/);
  });

  test('routine and rule lines read naturally for every shape', () => {
    const routine = (overrides: any) =>
      buildStandingOrders(
        sources({
          routines: [
            {
              id: 'r',
              title: 'R',
              kind: 'checkin',
              cadence: 'daily',
              daysOfWeek: null,
              localTime: '19:00',
              timezone: 'UTC',
              paused: true,
              nextRunAt: null,
              projectTitle: null,
              ...overrides,
            },
          ],
        }),
      )[1];
    expect(routine({}).detail).toBe('Every day at 19:00, asks a check-in question.');
    expect(routine({}).paused).toBe(true);
    expect(routine({ cadence: 'weekly', daysOfWeek: [1], kind: 'review' }).detail).toBe(
      'Every Monday at 19:00, asks for a review.',
    );
    expect(routine({ cadence: 'weekly', daysOfWeek: [] }).detail).toContain('Every week at 19:00');
    expect(routine({ cadence: 'custom', daysOfWeek: [2, 4], kind: 'task_and_checkin' }).detail).toBe(
      'Tuesday, Thursday at 19:00, adds a task and asks a check-in question.',
    );
    expect(routine({ cadence: 'custom', daysOfWeek: [] }).detail).toContain('On its own schedule');
    const ruleLine = (overrides: Partial<SmartRule>) =>
      buildStandingOrders(sources({ rules: [rule(overrides)] }))[2].detail;
    expect(ruleLine({ effect: 'never_main', scope: 'domain', match: 'example.test' })).toBe(
      'Keeps mail from example.test out of Main.',
    );
    expect(ruleLine({ effect: 'always_category', category: 'orders', scope: 'subject_pattern' })).toBe(
      'Files mail with “news@example.test” in the subject under Orders.',
    );
    expect(ruleLine({ effect: 'always_category', category: undefined, scope: 'thread' })).toBe(
      'Files one conversation under a category.',
    );
    expect(ruleLine({ effect: 'always_custom_label', scope: 'header' })).toBe(
      'Files mail that matches news@example.test under a label.',
    );
    expect(ruleLine({ effect: 'never_custom_label' })).toContain('out of a label');
    expect(ruleLine({ effect: 'other' as any })).toContain('Sorts mail from');
    const quiet = buildStandingOrders(sources({ watches: [] })).find((order) => order.id === 'watches');
    expect(quiet?.detail).toContain('Nothing waits now.');
    const one = buildStandingOrders(
      sources({ watches: [{ workId: 'w', title: 'T', kind: 'reply', waitingOn: [] }] }),
    ).find((order) => order.id === 'watches');
    expect(one?.detail).toContain('1 Albatross waits');
    expect(one?.items[0].detail).toBe('Waits for a reply');
  });

  test('switch documents keep only known keys as booleans', () => {
    expect(normalizeStandingOrderSwitches({ paused: { brief: true, other: true, watches: 'yes' } })).toEqual({
      ...NONE,
      brief: true,
    });
    expect(normalizeStandingOrderSwitches('nope')).toEqual(NONE);
  });
});

function fakeDeps() {
  const state = {
    switches: { ...NONE },
    routinePaused: { rt1: false } as Record<string, boolean>,
    rules: [rule()],
    sorting: {
      preferences: { enabled: true, briefNewsletters: false },
      corrections: [{ id: 'c' }],
      revision: 7,
    },
    content: { enabled: true, prepare: true },
    notifications: { oneTimeCodeCleanupEnabled: false, timezone: 'UTC' } as Record<string, any>,
  };
  const deps: StandingOrderDependencies = {
    readSwitches: mock(async () => ({ ...state.switches })),
    writeSwitches: mock(async (_user, next) => {
      state.switches = next;
    }),
    overview: mock(async () => ({
      routines: Object.entries(state.routinePaused).map(([id, paused]) => ({
        id,
        title: 'Stretch',
        kind: 'task' as const,
        cadence: 'daily' as const,
        daysOfWeek: null,
        localTime: '08:00',
        timezone: 'UTC',
        paused,
        nextRunAt: null,
        projectTitle: null,
      })),
      watches: [],
    })),
    setRoutinePaused: mock(async (_user, id, paused) => {
      if (!(id in state.routinePaused)) throw new Error('Routine not found.');
      state.routinePaused[id] = paused;
    }),
    listRules: mock(async () => state.rules),
    setRuleEnabled: mock(async (_user, id, enabled) => {
      state.rules = state.rules.map((entry) => (entry._id === id ? { ...entry, enabled } : entry));
    }),
    sortingPolicy: mock(async () => state.sorting),
    saveSortingPolicy: mock(async (_user, policy) => {
      state.sorting = { ...policy, revision: policy.revision + 1 };
    }),
    contentPreferences: mock(async () => state.content),
    saveContentPreferences: mock(async (_user, prefs) => {
      state.content = prefs;
    }),
    notificationPreferences: mock(async () => state.notifications),
    saveCodeCleanup: mock(async (_user, current, enabled) => {
      state.notifications = { ...current, oneTimeCodeCleanupEnabled: enabled };
    }),
  };
  return { state, deps };
}

describe('pausing and resuming', () => {
  test('each kind of order writes to its own home', async () => {
    const { state, deps } = fakeDeps();
    expect((await setStandingOrderPaused('u', 'brief', true, deps)).paused).toBe(true);
    expect(state.switches.brief).toBe(true);
    expect((await setStandingOrderPaused('u', 'risk:reach_person', true, deps)).paused).toBe(true);
    expect(state.switches['risk:reach_person']).toBe(true);

    expect((await setStandingOrderPaused('u', 'routine:rt1', true, deps)).paused).toBe(true);
    expect(state.routinePaused.rt1).toBe(true);

    expect((await setStandingOrderPaused('u', 'rule:r1', true, deps)).paused).toBe(true);
    expect(state.rules[0].enabled).toBe(false);
    await expect(setStandingOrderPaused('u', 'rule:missing', true, deps)).rejects.toThrow('Rule not found.');

    expect((await setStandingOrderPaused('u', 'sorting', true, deps)).paused).toBe(true);
    expect(deps.saveSortingPolicy).toHaveBeenCalledWith('u', {
      preferences: { enabled: false, briefNewsletters: false },
      corrections: [{ id: 'c' }],
      revision: 7,
    });

    expect((await setStandingOrderPaused('u', 'prepare', true, deps)).paused).toBe(true);
    expect(state.content).toEqual({ enabled: true, prepare: false });
    state.content = { enabled: false, prepare: false };
    expect((await setStandingOrderPaused('u', 'prepare', false, deps)).paused).toBe(false);
    // Prepared work needs connected content, so resuming turns both on.
    expect(state.content).toEqual({ enabled: true, prepare: true });

    expect((await setStandingOrderPaused('u', 'code_cleanup', false, deps)).paused).toBe(false);
    expect(state.notifications).toEqual({ oneTimeCodeCleanupEnabled: true, timezone: 'UTC' });
  });

  test('reads cannot be paused, and unknown ids are refused', async () => {
    const { deps } = fakeDeps();
    await expect(setStandingOrderPaused('u', 'risk:read', true, deps)).rejects.toBeInstanceOf(
      StandingOrderError,
    );
    const unknown = await setStandingOrderPaused('u', 'nonsense', true, deps).catch((error) => error);
    expect(unknown).toMatchObject({ status: 404 });
    expect((await listStandingOrders('u', deps)).length).toBe(11);
  });

  test('a routine the list no longer has is reported as not found', async () => {
    const { deps } = fakeDeps();
    deps.setRoutinePaused = mock(async () => undefined);
    deps.overview = mock(async () => ({ routines: [], watches: [] }));
    await expect(setStandingOrderPaused('u', 'routine:gone', true, deps)).rejects.toThrow(
      'Standing order not found.',
    );
  });
});

describe('enforcement reads', () => {
  test('switches are cached briefly and a write drops the cache', async () => {
    const read = mock(async () => ({ ...NONE, brief: true }));
    expect((await loadStandingOrderSwitches('u', read, 1_000)).brief).toBe(true);
    await loadStandingOrderSwitches('u', read, 2_000);
    expect(read).toHaveBeenCalledTimes(1);
    await loadStandingOrderSwitches('u', read, 20_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  test('the assistant sees its paused classes, and a failed read pauses nothing', async () => {
    const read = async () => ({ ...NONE, 'risk:write_self': true, 'risk:destructive': true });
    expect([...(await pausedAssistantRisks('u1', read))].sort()).toEqual(['destructive', 'write_self']);
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    restores.push(() => warn.mockRestore());
    const failing = async () => {
      throw new Error('offline');
    };
    expect((await pausedAssistantRisks('u2', failing)).size).toBe(0);
    expect(await isStandingOrderPaused('u3', 'brief', failing)).toBe(false);
    expect(await isStandingOrderPaused('u4', 'watches', async () => ({ ...NONE, watches: true }))).toBe(true);
  });

  test('the default store round-trips the switch document', async () => {
    await standingOrderDefaults.writeSwitches('store_user', { ...NONE, watches: true });
    expect((await standingOrderDefaults.readSwitches('store_user')).watches).toBe(true);
    const doc = await runWithAiRequestContext({ userId: 'store_user', agent: 'user' }, () =>
      kvGet<any>('standingOrders', 'default'),
    );
    expect(doc.paused.watches).toBe(true);
    expect(await isStandingOrderPaused('store_user', 'watches')).toBe(true);
    await runWithAiRequestContext({ userId: 'store_user', agent: 'user' }, () =>
      kvUpsert('contentPreferences', 'default', { enabled: true, prepare: false }),
    );
    expect(await standingOrderDefaults.contentPreferences('store_user')).toEqual({
      enabled: true,
      prepare: false,
    });
    expect(await standingOrderDefaults.contentPreferences('nobody')).toEqual({
      enabled: true,
      prepare: true,
    });
  });
});

describe('the routes honor a pause', () => {
  function cronRequest(path: string, body: unknown) {
    return new NextRequest(`https://mail.lab86.io${path}`, {
      method: 'POST',
      headers: { host: 'mail.lab86.io', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('a paused Brief gets no morning edition; a manual one still runs', async () => {
    const enqueue = mock(async () => ({ jobId: 'job' }));
    const post = createDailyReportPost({
      isInternalCronRequest: () => true,
      isStagingRuntime: () => false,
      enqueue: enqueue as any,
      briefPaused: async () => true,
    });
    const skipped = await post(cronRequest('/api/cron/daily-report', { userId: 'u', kind: 'morning' }));
    expect(await skipped.json()).toEqual({ ok: true, skipped: true, reason: 'paused' });
    expect(enqueue).not.toHaveBeenCalled();
    const manual = await post(cronRequest('/api/cron/daily-report', { userId: 'u' }));
    expect(manual.status).toBe(202);
  });

  test('paused watches read nothing', async () => {
    const convexQuery = mock(async () => null);
    const post = createStepWatchPost({
      isInternalCronRequest: () => true,
      convexQuery: convexQuery as any,
      watchesPaused: async () => true,
    });
    const response = await post(cronRequest('/api/cron/step-watch', { userId: 'u', workId: 'w' }));
    expect(await response.json()).toEqual({ ok: true, skipped: 'paused' });
    expect(convexQuery).not.toHaveBeenCalled();
  });

  test('the standing orders route lists, toggles, and explains failures', async () => {
    const order = buildStandingOrders(sources())[0];
    const route = createStandingOrdersRoute({
      requireCurrentUser: async () => ({ userId: 'u', email: 'u@example.test', name: 'U', source: 'clerk' }),
      enforceUserRateLimit: async () => undefined as any,
      listStandingOrders: async () => [order],
      setStandingOrderPaused: async (_user, id, paused) => ({ ...order, id, paused }),
    });
    expect(await (await route.GET()).json()).toEqual({ ok: true, orders: [order] });
    const post = (body: unknown) =>
      route.POST(
        new Request('https://x/api/standing-orders', { method: 'POST', body: JSON.stringify(body) }),
      );
    expect((await post({ id: 'brief' })).status).toBe(400);
    expect(await (await post({ id: 'brief', paused: true })).json()).toMatchObject({
      ok: true,
      order: { id: 'brief', paused: true },
    });
    const refusing = createStandingOrdersRoute({
      requireCurrentUser: async () => ({ userId: 'u', email: '', name: '', source: 'clerk' }),
      enforceUserRateLimit: async () => undefined as any,
      setStandingOrderPaused: async () => {
        throw new StandingOrderError('Looking things up cannot be paused.');
      },
      listStandingOrders: async () => {
        throw new Error('boom');
      },
    });
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    restores.push(() => error.mockRestore());
    expect((await refusing.GET()).status).toBe(500);
    const refused = await refusing.POST(
      new Request('https://x', { method: 'POST', body: JSON.stringify({ id: 'risk:read', paused: true }) }),
    );
    expect(refused.status).toBe(400);
  });
});

describe('Convex standing orders', () => {
  const SECRET = 'standing-orders-secret';
  const USER = 'orders_user';
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
  });
  let t: ReturnType<typeof convexTest>;
  beforeEach(() => {
    t = convexTest(schema, {
      '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
      '../convex/standingOrders.ts': () => import('../convex/standingOrders'),
    });
  });

  async function seed() {
    return t.run(async (ctx) => {
      const projectId = await ctx.db.insert('albatrossProjects', {
        userId: USER,
        title: 'Health',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      } as any);
      const base = {
        userId: USER,
        projectId,
        kind: 'task',
        cadence: 'daily',
        localTime: '08:00',
        timezone: 'UTC',
        notification: { enabled: false, channel: 'in_app' },
        nextRunAt: 5,
        createdAt: 1,
        updatedAt: 1,
      };
      const active = await ctx.db.insert('albatrossRoutines', {
        ...base,
        title: 'Stretch',
        status: 'active',
        consent: 'enabled',
      } as any);
      await ctx.db.insert('albatrossRoutines', {
        ...base,
        title: 'Proposed',
        status: 'proposed',
        consent: 'proposed',
      } as any);
      const intent = {
        userId: USER,
        rawText: 'Book the venue',
        source: 'chat',
        status: 'ready',
        createdAt: 1,
        updatedAt: 1,
      };
      await ctx.db.insert('albatrossIntents', {
        ...intent,
        title: 'Venue',
        workState: 'waiting',
        replyWatch: {
          id: 'watch',
          accountId: 'a',
          threadId: 't',
          senderEmails: ['maya@example.test'],
          requirement: 'reply',
          after: 1,
          startedAt: 1,
        },
      } as any);
      await ctx.db.insert('albatrossIntents', { ...intent, workState: 'active', mailWatchAt: 3 } as any);
      await ctx.db.insert('albatrossIntents', { ...intent, title: 'Quiet', workState: 'active' } as any);
      return { active: String(active) };
    });
  }

  test('overview lists agreed routines and watched Work only', async () => {
    const { active } = await seed();
    const view = await t.query((api as any).standingOrders.overview, {
      internalSecret: SECRET,
      userId: USER,
    });
    expect(view.routines).toEqual([
      expect.objectContaining({ id: active, title: 'Stretch', paused: false, projectTitle: 'Health' }),
    ]);
    expect(view.watches).toEqual(
      expect.arrayContaining([
        { workId: expect.any(String), title: 'Venue', kind: 'reply', waitingOn: ['maya@example.test'] },
        { workId: expect.any(String), title: 'Book the venue', kind: 'step', waitingOn: [] },
      ]),
    );
    expect(view.watches).toHaveLength(2);
    await expect(
      t.query((api as any).standingOrders.overview, { internalSecret: 'wrong', userId: USER }),
    ).rejects.toThrow();
  });

  test('a routine pauses and resumes with a fresh next run', async () => {
    const { active } = await seed();
    const args = { internalSecret: SECRET, userId: USER, routineId: active };
    expect(await t.mutation((api as any).standingOrders.setRoutinePaused, { ...args, paused: true })).toEqual(
      {
        paused: true,
        nextRunAt: null,
      },
    );
    const resumed = await t.mutation((api as any).standingOrders.setRoutinePaused, {
      ...args,
      paused: false,
    });
    expect(resumed.paused).toBe(false);
    expect(resumed.nextRunAt).toBeGreaterThan(Date.now() - 60_000);
    const row = await t.run((ctx) => ctx.db.get(active as any));
    expect(row).toMatchObject({ status: 'active', consent: 'enabled' });
    await expect(
      t.mutation((api as any).standingOrders.setRoutinePaused, { ...args, userId: 'someone', paused: true }),
    ).rejects.toThrow('Routine not found.');
    await expect(
      t.mutation((api as any).standingOrders.setRoutinePaused, { ...args, routineId: 'bad', paused: true }),
    ).rejects.toThrow('Routine not found.');
  });

  test('a routine the user never agreed to cannot be paused here', async () => {
    await seed();
    const proposed = await t.run(async (ctx) => {
      const rows = await ctx.db.query('albatrossRoutines').collect();
      return String(rows.find((row) => row.consent === 'proposed')!._id);
    });
    await expect(
      t.mutation((api as any).standingOrders.setRoutinePaused, {
        internalSecret: SECRET,
        userId: USER,
        routineId: proposed,
        paused: true,
      }),
    ).rejects.toThrow('Only a routine you turned on');
  });
});

describe('the default Convex wiring', () => {
  test('each default reads or writes the right Convex function with the user', async () => {
    const convex = await import('../lib/hosted/convex');
    const calls: Array<[string, any]> = [];
    const name = (fn: any) => String(fn?.[Symbol.for('functionName')] ?? fn);
    const query = spyOn(convex, 'convexQuery').mockImplementation((async (fn: any, args: any) => {
      calls.push([name(fn), args]);
      return { routines: [], watches: [] };
    }) as any);
    const mutation = spyOn(convex, 'convexMutation').mockImplementation((async (fn: any, args: any) => {
      calls.push([name(fn), args]);
      return null;
    }) as any);
    restores.push(
      () => query.mockRestore(),
      () => mutation.mockRestore(),
    );
    await standingOrderDefaults.overview('u');
    await standingOrderDefaults.setRoutinePaused('u', 'r1', true);
    await standingOrderDefaults.sortingPolicy('u');
    await standingOrderDefaults.saveSortingPolicy('u', { preferences: {}, corrections: [], revision: 3 });
    await standingOrderDefaults.saveContentPreferences('u', { enabled: true, prepare: false });
    await standingOrderDefaults.notificationPreferences('u');
    await standingOrderDefaults.saveCodeCleanup(
      'u',
      {
        nativePushEnabled: true,
        newMailPushEnabled: true,
        eventSuggestionPushEnabled: true,
        eveningCheckinEnabled: false,
        eveningCheckinLocalTime: '20:00',
        inAppEnabled: true,
        emailFallbackEnabled: false,
        emailFallbackDelayMinutes: 60,
        timezone: 'UTC',
        briefLatitude: 1,
      },
      true,
    );
    expect(calls.map(([fn]) => fn)).toEqual([
      'standingOrders:overview',
      'standingOrders:setRoutinePaused',
      'jev:policy',
      'jev:saveSettings',
      'content:savePreferences',
      'albatrossNotifications:mobilePreferences',
      'albatrossNotifications:saveMobilePreferences',
    ]);
    expect(calls[1][1]).toEqual({ userId: 'u', routineId: 'r1', paused: true });
    // Only the required fields and the one flag: optional fields keep their stored values.
    expect(calls[6][1]).toEqual({
      userId: 'u',
      nativePushEnabled: true,
      newMailPushEnabled: true,
      eventSuggestionPushEnabled: true,
      eveningCheckinEnabled: false,
      eveningCheckinLocalTime: '20:00',
      inAppEnabled: true,
      emailFallbackEnabled: false,
      emailFallbackDelayMinutes: 60,
      timezone: 'UTC',
      oneTimeCodeCleanupEnabled: true,
    });
  });

  test('smart rules go through the per-user rule store', async () => {
    await runWithAiRequestContext({ userId: 'rules_user', agent: 'user' }, () =>
      kvUpsert('smartRule', 'r9', rule({ _id: 'r9' })),
    );
    expect((await standingOrderDefaults.listRules('rules_user')).map((entry) => entry._id)).toEqual(['r9']);
    await standingOrderDefaults.setRuleEnabled('rules_user', 'r9', false);
    expect((await standingOrderDefaults.listRules('rules_user'))[0].enabled).toBe(false);
  });
});

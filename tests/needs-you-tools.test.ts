import { afterEach, describe, expect, test } from 'bun:test';
import { APPROVAL_GATED_TOOLS, APPROVAL_RISKS } from '../lib/ai/approval';
import { AGENT_TOOL_NAMES, liftToolsForAgent } from '../lib/ai/loop';
import { buildSystemPrompt, toolGroupsForPlatform } from '../lib/ai/system-prompt';
import {
  activeToolNames,
  enableToolsDescription,
  requestToolGroups,
  TOOL_GROUPS,
} from '../lib/ai/tool-groups';
import { resolveToolShape } from '../lib/ai/tool-shapes';
import { toolSentences } from '../lib/albatross/teach-ui';
import { obligationActionDefaults } from '../lib/obligations/action-deps';
import {
  type NeedsYouSnapshot,
  needsYouFlagFor,
  type ObligationView,
  UNDO_WINDOW_MS,
} from '../lib/obligations/contract';
import { ObligationApiError, type ObligationRecord } from '../lib/obligations/service';
import { TOOLS } from '../lib/tools';
import {
  needsYouDone,
  needsYouLater,
  needsYouList,
  needsYouNotMine,
  needsYouToolDeps,
  undoNeedsYouAction,
} from '../lib/tools/needs-you';
import { invokeTool, toolRisk } from '../lib/tools/registry';

// The chat side of Needs you. Invented people only. The ledger calls are fakes.

const NOW = Date.parse('2026-10-30T15:00:00Z');
const USER = 'user-1';
const CODE = 'K7Q-48213';
const ctx = { agent: 'ai' as const, userId: USER, userTimezone: 'America/New_York' };

function view(patch: Partial<ObligationView> = {}): ObligationView {
  return {
    id: 'ob_reply',
    kind: 'reply',
    state: 'open',
    source: 'mail',
    sourceKey: 'mail:acct:thread',
    accountId: 'acct',
    threadId: 'thread',
    messageId: 'm1',
    title: 'Confirm the start date',
    asker: 'Dana Whitfield',
    why: 'Dana asks for the start date by Friday.',
    excerpt: 'Could you confirm the start date?',
    due: 'today',
    pushLevel: 'normal',
    probability: 0.97,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 3_600_000,
    ...patch,
  };
}

const codeView = (patch: Partial<ObligationView> = {}) =>
  view({
    id: 'ob_code',
    kind: 'code',
    title: `Sign-in code for Northwind`,
    asker: 'Northwind',
    why: 'Northwind sent a sign-in code.',
    excerpt: `Your code is ${CODE}`,
    pushLevel: 'time_sensitive',
    code: { value: CODE, issuer: 'Northwind', expiresAt: NOW + 300_000 },
    ...patch,
  });

const original = { ...needsYouToolDeps };
afterEach(() => Object.assign(needsYouToolDeps, original));

function useSnapshot(items: ObligationView[], enabled = true) {
  const snapshot: NeedsYouSnapshot = { enabled, timezone: 'UTC', items };
  needsYouToolDeps.now = () => NOW;
  needsYouToolDeps.service = { ...original.service, flag: () => true };
  needsYouToolDeps.snapshot = async () => snapshot;
}

function useService(record: ObligationRecord | null, undoUntil: number | undefined = NOW + UNDO_WINDOW_MS) {
  const acts: any[] = [];
  const operations: any[] = [];
  needsYouToolDeps.service = {
    flag: () => true,
    get: async () => record,
    act: async (input) => {
      acts.push(input);
      if (!record) return { ok: false, error: 'not_found' };
      const state = input.action === 'later' ? 'snoozed' : input.action === 'not_mine' ? 'dismissed' : 'done';
      return {
        ok: true,
        obligation: {
          ...record.obligation,
          state: input.action === 'undo' ? 'open' : state,
          ...(input.until ? { snoozedUntil: input.until } : {}),
        },
        ...(undoUntil ? { undoUntil } : {}),
      };
    },
    correctionFor: (target) => ({ id: `correction:${target.threadId}` }) as any,
    cancelSend: async () => true,
  };
  needsYouToolDeps.recordOperation = (async (input: any) => {
    operations.push(input);
    return 'op_1';
  }) as any;
  return { acts, operations };
}

const record = (obligation: ObligationView): ObligationRecord => ({
  obligation,
  sourceMessageId: 'm1',
  undo: null,
  draft: null,
});

describe('needs_you_list', () => {
  test('returns each item with its group, title, asker, source, due, why, and id, in page order', async () => {
    useSnapshot([
      view({ id: 'later', due: 'none' }),
      view({
        id: 'slack',
        source: 'slack',
        sourceLabel: '#release',
        accountId: undefined,
        threadId: undefined,
        url: 'https://acme.example/slack/1',
        workId: 'work_1',
        workTitle: 'Launch',
        title: 'Answer Priya on the numbers',
        asker: 'Priya Anand',
        dueAt: NOW + 3_600_000,
      }),
    ]);
    const result: any = await needsYouList.handler({}, ctx);
    expect(result.enabled).toBe(true);
    expect(result.counts).toEqual({ today: 1, no_date: 1 });
    expect(result.total).toBe(2);
    expect(result.summary).toBe('2 open: 1 today, 1 no due date.');
    expect(result.items.map((item: any) => item.id)).toEqual(['slack', 'later']);
    expect(result.items[0]).toEqual({
      id: 'slack',
      group: 'today',
      groupLabel: 'Today',
      kind: 'reply',
      state: 'open',
      source: 'slack',
      sourceName: 'Slack',
      due: 'today',
      dueAt: new Date(NOW + 3_600_000).toISOString(),
      title: 'Answer Priya on the numbers',
      asker: 'Priya Anand',
      why: 'Dana asks for the start date by Friday.',
      where: '#release',
      url: 'https://acme.example/slack/1',
      workId: 'work_1',
      workTitle: 'Launch',
    });
    expect(result.items[1]).toMatchObject({ account: 'acct', threadId: 'thread', group: 'no_date' });
    // The excerpt stays out: `why` is the line the page shows.
    expect('excerpt' in result.items[0]).toBe(false);
  });

  test('filters by group and by source, and shows closed items only when asked', async () => {
    useSnapshot([
      view({ id: 'mail_today' }),
      view({ id: 'jira_today', source: 'atlassian' }),
      view({ id: 'waiting', kind: 'waiting' }),
      view({ id: 'closed', state: 'done', closeReason: 'user_done', closedAt: NOW - 1_000 }),
    ]);
    const ids = async (input: any) =>
      ((await needsYouList.handler(input, ctx)) as any).items.map((item: any) => item.id);
    expect(await ids({})).toEqual(expect.not.arrayContaining(['closed']));
    expect((await ids({})).length).toBe(3);
    expect(await ids({ group: 'waiting' })).toEqual(['waiting']);
    expect(await ids({ source: 'atlassian' })).toEqual(['jira_today']);
    expect(await ids({ group: 'closed_today' })).toEqual(['closed']);
    expect(await ids({ group: 'now' })).toEqual([]);
  });

  test('an empty list says so, and it has no card', async () => {
    useSnapshot([]);
    const result = await needsYouList.handler({}, ctx);
    expect(result).toMatchObject({ enabled: true, items: [], total: 0, summary: 'Nothing is open.' });
    const shape = resolveToolShape('needs_you_list', {}, result);
    expect(shape).toMatchObject({ kind: 'text', text: 'Nothing is open.' });
  });

  test('the list holds at most 40 items, and `total` says how many there are', async () => {
    useSnapshot(Array.from({ length: 45 }, (_, index) => view({ id: `ob_${index}` })));
    const result: any = await needsYouList.handler({}, ctx);
    expect(result.items).toHaveLength(40);
    expect(result.total).toBe(45);
  });

  test('a long `why` is cut', async () => {
    useSnapshot([view({ why: 'word '.repeat(200) })]);
    const result: any = await needsYouList.handler({}, ctx);
    expect(result.items[0].why.length).toBeLessThanOrEqual(301);
  });

  test('needs a signed-in user', async () => {
    useSnapshot([]);
    await expect(needsYouList.handler({}, { agent: 'ai' })).rejects.toThrow('signed-in user');
  });
});

describe('a one-time code never reaches the model', () => {
  test('a code item says that a code exists and names its issuer, with no value', async () => {
    useSnapshot([codeView()]);
    const result: any = await needsYouList.handler({}, ctx);
    const [item] = result.items;
    expect(item).toEqual({
      id: 'ob_code',
      group: 'now',
      groupLabel: 'Now',
      kind: 'code',
      state: 'open',
      source: 'mail',
      sourceName: 'Mail',
      due: 'today',
      title: 'Sign-in code for Northwind',
      asker: 'Northwind',
      code: { available: true, issuer: 'Northwind', expiresAt: new Date(NOW + 300_000).toISOString() },
    });
    // No field can quote the code mail, and no field points the model at it.
    expect(JSON.stringify(result)).not.toContain(CODE);
    expect('excerpt' in item || 'why' in item || 'threadId' in item || 'account' in item).toBe(false);
  });

  test('the value does not leak through a title, an asker, or another item of the thread', async () => {
    useSnapshot([
      codeView({ title: `Your code is ${CODE}`, asker: 'Code 482913 from Northwind' }),
      view({ id: 'sibling', title: `Confirm ${CODE}`, why: `The mail says ${CODE}.`, asker: `Bot ${CODE}` }),
    ]);
    const result: any = await needsYouList.handler({}, ctx);
    const text = JSON.stringify(result);
    expect(text).not.toContain(CODE);
    expect(result.items[0].title).toBe('Sign-in code for Northwind');
    expect(result.items.find((item: any) => item.id === 'sibling')).toMatchObject({
      title: 'Confirm [hidden]',
      asker: 'Bot [hidden]',
      why: 'The mail says [hidden].',
    });
  });

  test('a code with no issuer hides a digit run in the sender name', async () => {
    useSnapshot([
      codeView({ asker: 'Code 482913', code: { value: CODE, expiresAt: NOW + 300_000 } }),
      codeView({ id: 'expired_code', asker: 'Login 7719', code: undefined, dueAt: NOW + 60_000 }),
    ]);
    const result: any = await needsYouList.handler({}, ctx);
    const text = JSON.stringify(result);
    expect(text).not.toContain('482913');
    expect(text).not.toContain('7719');
    expect(result.items.map((item: any) => item.code.available).sort()).toEqual([false, true]);
  });

  test('an action on a code returns no value, and neither does its receipt or its audit detail', async () => {
    const { operations } = useService(record(codeView({ title: `Your code is ${CODE}` })));
    const result: any = await needsYouDone.handler({ id: 'ob_code' }, ctx);
    expect(result).toMatchObject({ ok: true, title: 'Sign-in code for Northwind', asker: 'Northwind' });
    expect(JSON.stringify(result)).not.toContain(CODE);
    expect(JSON.stringify(operations)).not.toContain(CODE);
    expect(JSON.stringify(resolveToolShape('needs_you_done', { id: 'ob_code' }, result))).not.toContain(CODE);
  });

  test('the chat card of a code item has no value and no way to the mail', async () => {
    useSnapshot([codeView()]);
    const result = await needsYouList.handler({}, ctx);
    const shape: any = resolveToolShape('needs_you_list', {}, result);
    expect(JSON.stringify(shape)).not.toContain(CODE);
    expect(shape.items[0].actions).toEqual([]);
  });
});

describe('the actions', () => {
  test('Done runs the action of the page, with the same Undo window, and records the Undo', async () => {
    const { acts, operations } = useService(record(view()));
    const result: any = await needsYouDone.handler(
      { id: 'ob_reply' },
      { ...ctx, userEmail: 'a@b.test', userName: 'A' },
    );
    expect(acts).toEqual([{ userId: USER, id: 'ob_reply', action: 'done' }]);
    expect(result).toEqual({
      ok: true,
      id: 'ob_reply',
      state: 'done',
      title: 'Confirm the start date',
      asker: 'Dana Whitfield',
      undoUntil: new Date(NOW + UNDO_WINDOW_MS).toISOString(),
      operationId: 'op_1',
      summary: 'Undo stays open for 10 seconds.',
    });
    expect(operations[0]).toEqual({
      userId: USER,
      tool: 'needs_you_done',
      surface: 'albatross',
      summary: 'Marked done: Confirm the start date',
      target: { obligationId: 'ob_reply' },
      inverse: { kind: 'needs_you_undo', payload: { id: 'ob_reply' } },
    });
  });

  test('Later reads a time with no offset in the user zone, and sends the epoch time', async () => {
    const { acts } = useService(record(view()));
    const result: any = await needsYouLater.handler({ id: 'ob_reply', until: '2026-11-02T09:00:00' }, ctx);
    const until = Date.parse('2026-11-02T14:00:00Z');
    expect(acts[0]).toEqual({ userId: USER, id: 'ob_reply', action: 'later', until });
    expect(result).toMatchObject({ state: 'snoozed', snoozedUntil: new Date(until).toISOString() });
    await expect(needsYouLater.handler({ id: 'ob_reply', until: 'soon' }, ctx)).rejects.toThrow(
      'Invalid ISO timestamp',
    );
  });

  test('Not mine on mail sends the scoped correction; on another source it does not', async () => {
    const mail = useService(record(view()));
    await needsYouNotMine.handler({ id: 'ob_reply' }, ctx);
    expect(mail.acts[0]).toEqual({
      userId: USER,
      id: 'ob_reply',
      action: 'not_mine',
      correction: { id: 'correction:thread' },
    });
    const slack = useService(record(view({ source: 'slack' })));
    await needsYouNotMine.handler({ id: 'ob_reply' }, ctx);
    expect(slack.acts[0]).toEqual({ userId: USER, id: 'ob_reply', action: 'not_mine' });
  });

  test('a result with no Undo records no inverse', async () => {
    const { operations } = useService(record(view()), 0);
    const result: any = await needsYouDone.handler({ id: 'ob_reply' }, ctx);
    expect(operations[0].inverse).toBeUndefined();
    expect(result.undoUntil).toBeUndefined();
    expect(result.summary).toBeUndefined();
  });

  test('the errors of the service reach the model', async () => {
    useService(null);
    const failure = needsYouDone.handler({ id: 'other_user_item' }, ctx);
    await expect(failure).rejects.toThrow('Not found.');
    await expect(failure).rejects.toBeInstanceOf(ObligationApiError);
  });

  test('a failed Later reads as the page reads it', async () => {
    useService(record(view()));
    needsYouToolDeps.service = {
      ...needsYouToolDeps.service,
      act: async () => ({ ok: false, error: 'invalid' }),
    };
    await expect(
      needsYouLater.handler({ id: 'ob_reply', until: '2030-01-01T00:00:00Z' }, ctx),
    ).rejects.toThrow('Choose a time in the future, at most 90 days away.');
  });

  test('the Undo of a chat action is the Undo of the page', async () => {
    const { acts } = useService(record(view()));
    await undoNeedsYouAction({ id: 'ob_reply' }, { userId: USER });
    expect(acts).toEqual([{ userId: USER, id: 'ob_reply', action: 'undo' }]);
  });

  test('an Undo after the window says so', async () => {
    useService(record(view()));
    needsYouToolDeps.service = {
      ...needsYouToolDeps.service,
      act: async () => ({ ok: false, error: 'undo_expired' }),
    };
    await expect(undoNeedsYouAction({ id: 'ob_reply' }, { userId: USER })).rejects.toThrow(
      'Undo is no longer available.',
    );
  });

  test('a call through the registry writes the same audit as any tool, and keeps its input', async () => {
    const { acts } = useService(record(view()));
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: unknown) => lines.push(String(line));
    try {
      await invokeTool(TOOLS.needs_you_done, { id: 'ob_reply' }, ctx);
    } finally {
      console.log = log;
    }
    expect(acts).toHaveLength(1);
    expect(lines.some((line) => line.includes('[audit]') && line.includes('needs_you_done'))).toBe(true);
  });
});

describe('outside the flag', () => {
  test('each tool gives a short plain result and reads nothing', async () => {
    let reads = 0;
    needsYouToolDeps.service = {
      ...original.service,
      flag: () => false,
      get: async () => {
        reads += 1;
        return null;
      },
    };
    needsYouToolDeps.snapshot = async () => {
      reads += 1;
      return { enabled: true, timezone: 'UTC', items: [] };
    };
    const message = 'Needs you is not available for this account.';
    expect(await needsYouList.handler({}, ctx)).toEqual({ enabled: false, items: [], message });
    const off = { ok: false, message };
    expect(await needsYouDone.handler({ id: 'x' }, ctx)).toEqual(off);
    expect(await needsYouLater.handler({ id: 'x', until: '2026-11-02T09:00:00Z' }, ctx)).toEqual(off);
    expect(await needsYouNotMine.handler({ id: 'x' }, ctx)).toEqual(off);
    expect(reads).toBe(0);
  });

  test('a snapshot that says off gives the same result', async () => {
    useSnapshot([view()], false);
    expect(await needsYouList.handler({}, ctx)).toMatchObject({ enabled: false, items: [] });
  });

  test('the action defaults read the same flag as the page', () => {
    const previous = process.env.LAB86_NEEDS_YOU;
    process.env.LAB86_NEEDS_YOU = 'someone-else';
    try {
      expect(obligationActionDefaults.flag(USER)).toBe(false);
      expect(obligationActionDefaults.flag('someone-else')).toBe(needsYouFlagFor('someone-else'));
      expect(obligationActionDefaults.correctionFor({ accountId: 'acct', threadId: 'thread' })).toMatchObject(
        { id: expect.stringContaining('thread') },
      );
    } finally {
      if (previous === undefined) delete process.env.LAB86_NEEDS_YOU;
      else process.env.LAB86_NEEDS_YOU = previous;
    }
  });

  test('the prompt, the group list, and the preload do not change', () => {
    const plain = buildSystemPrompt({ email: 'u@example.test' });
    expect(plain).not.toContain('needs_you');
    expect(toolGroupsForPlatform('web')).not.toContain('needs_you');
    expect(toolGroupsForPlatform('ios')).not.toContain('needs_you');
    expect(requestToolGroups('What needs my attention?')).toEqual([]);
    expect(enableToolsDescription(toolGroupsForPlatform('web'))).not.toContain('needs_you');
  });
});

describe('the wiring in the agent', () => {
  test('the four tools are agent tools in one small group, and only that group loads them', () => {
    expect([...TOOL_GROUPS.needs_you.tools]).toEqual([
      'needs_you_list',
      'needs_you_done',
      'needs_you_later',
      'needs_you_not_mine',
    ]);
    for (const name of TOOL_GROUPS.needs_you.tools) {
      expect(AGENT_TOOL_NAMES.has(name)).toBe(true);
      expect(TOOLS[name]).toBeTruthy();
    }
    const lifted = Object.keys(liftToolsForAgent('b', 'UTC', undefined, { needsYou: true }));
    expect(lifted).toContain('needs_you_list');
    expect(activeToolNames(lifted, [])).not.toContain('needs_you_list');
    expect(activeToolNames(lifted, ['needs_you'])).toContain('needs_you_not_mine');
  });

  test('the actions change only the user list, so they do not ask for approval', () => {
    expect(toolRisk(needsYouList)).toBe('read');
    for (const tool of [needsYouDone, needsYouLater, needsYouNotMine]) {
      expect(toolRisk(tool)).toBe('write_self');
      expect(APPROVAL_RISKS.has(toolRisk(tool))).toBe(false);
      expect(APPROVAL_GATED_TOOLS.has(tool.name)).toBe(false);
    }
    const lifted = liftToolsForAgent('b', 'UTC', undefined, { needsYou: true });
    expect(lifted.needs_you_done.needsApproval).toBeUndefined();
  });

  test('a paused risk class stops the actions, as for any write_self tool', async () => {
    const { acts } = useService(record(view()));
    const lifted = liftToolsForAgent('b', 'UTC', undefined, {
      pausedRisks: new Set(['write_self'] as const),
    });
    expect(await lifted.needs_you_done.execute({ id: 'ob_reply' })).toMatchObject({
      status: 'paused_by_user',
    });
    expect(acts).toEqual([]);
  });

  test('a question on what the user owes preloads the group for a user in the flag', () => {
    for (const text of [
      'What needs my attention?',
      'Does anything need my attention today',
      'what needs me',
      'Show my Needs you list',
      'What do I owe people this week?',
      'Who is waiting on me?',
      "What's on my plate",
      'List my obligations',
      'What do I need to do today?',
      'what do i have to answer',
      'What must I do?',
    ])
      expect(requestToolGroups(text, { needsYou: true })).toEqual(['needs_you']);
    for (const text of ['Summarize the Stripe thread', 'What does Dana need?', 'I owe Dana a call', ''])
      expect(requestToolGroups(text, { needsYou: true })).toEqual([]);
    expect(requestToolGroups(null, { needsYou: true })).toEqual([]);
    expect(requestToolGroups('Make the invoice. What needs my attention?', { needsYou: true })).toEqual([
      'documents_more',
      'needs_you',
    ]);
  });

  test('the prompt of a user in the flag names the list and the group', () => {
    const prompt = buildSystemPrompt({ email: 'u@example.test' }, { needsYou: true });
    expect(prompt).toContain('reads needs_you_list first');
    expect(toolGroupsForPlatform('web', { needsYou: true })).toContain('needs_you');
    expect(toolGroupsForPlatform('macos', { needsYou: true })).toContain('needs_you');
    expect(prompt.length - buildSystemPrompt({ email: 'u@example.test' }).length).toBeLessThan(260);
  });
});

describe('the chat cards', () => {
  test('the list uses the sources shape, and each row opens its own source', async () => {
    useSnapshot([
      view({ id: 'mail' }),
      view({
        id: 'slack',
        source: 'slack',
        accountId: undefined,
        threadId: undefined,
        url: 'https://acme.example/slack/1',
        title: 'Answer Priya',
        asker: 'Priya Anand',
      }),
      view({
        id: 'work',
        accountId: undefined,
        threadId: undefined,
        workId: 'work_1',
        why: undefined,
        asker: '',
      }),
    ]);
    const result = await needsYouList.handler({}, ctx);
    const shape: any = resolveToolShape('needs_you_list', {}, result);
    expect(shape.kind).toBe('sources');
    expect(shape.title).toBe('Needs you');
    expect(shape.summary).toBe('3 open: 3 today.');
    const row = (title: string) => shape.items.filter((item: any) => item.title === title);
    expect(row('Confirm the start date')[0]).toMatchObject({
      source: 'Today · Mail',
      snippet: 'Dana Whitfield: Dana asks for the start date by Friday.',
    });
    expect(shape.items.map((item: any) => item.actions.map((action: any) => action.kind))).toEqual(
      expect.arrayContaining([['open_thread'], ['open_url'], ['open_work']]),
    );
  });

  test('an action uses the receipt shape, with the Undo that Activity has', async () => {
    useService(record(view()));
    const result = await needsYouDone.handler({ id: 'ob_reply' }, ctx);
    expect(resolveToolShape('needs_you_done', { id: 'ob_reply' }, result)).toMatchObject({
      kind: 'receipt',
      title: 'Marked done: Confirm the start date',
      summary: 'Undo stays open for 10 seconds.',
      surface: 'albatross',
      operationId: 'op_1',
      target: { obligationId: 'ob_reply' },
      actions: [{ kind: 'undo_operation', operationId: 'op_1' }],
    });
  });

  test('the sentences name the action; a failed call has no card', () => {
    expect(toolSentences('needs_you_list', {}, {})).toEqual({
      running: 'Reading what needs you',
      done: 'Read what needs you',
      failed: 'The read of what needs you failed',
    });
    for (const [name, title, done, bare] of [
      ['needs_you_done', 'T', 'Marked done: T', 'Marked the item done'],
      ['needs_you_later', 'T', 'Moved to later: T', 'Moved the item to later'],
      ['needs_you_not_mine', 'T', 'Marked not mine: T', 'Marked the item not mine'],
    ]) {
      expect(toolSentences(name, {}, { title }).done).toBe(done);
      expect(toolSentences(name, {}, {}).done).toBe(bare);
      expect(toolSentences(name, {}, {}).failed).toContain('failed');
    }
    expect(
      resolveToolShape('needs_you_done', { id: 'x' }, { ok: false, message: 'Needs you is off.' }),
    ).toBeNull();
    expect(
      resolveToolShape('needs_you_list', {}, { enabled: false, items: [], message: 'Off.' }),
    ).toMatchObject({
      kind: 'text',
      text: 'Off.',
    });
  });
});

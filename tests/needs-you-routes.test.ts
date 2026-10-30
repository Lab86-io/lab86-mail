import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createObligationDraftPost } from '../app/api/obligations/[id]/draft/route';
import { createObligationReplyPost } from '../app/api/obligations/[id]/reply/route';
import { createObligationActionPost } from '../app/api/obligations/[id]/route';
import { obligationServiceDefaults } from '../app/api/obligations/shared';
import { AuthRequiredError } from '../lib/auth/current-user';
import { briefThreadCorrectionId } from '../lib/brief/steering';
import { needsYouFlagFor, type ObligationView } from '../lib/obligations/contract';
import type { ObligationRecord, ObligationServiceDependencies } from '../lib/obligations/service';
import { RateLimitError } from '../lib/rate-limit';

const NOW = Date.parse('2026-10-30T15:00:00Z');

function view(patch: Partial<ObligationView> = {}): ObligationView {
  return {
    id: 'ob1',
    kind: 'reply',
    state: 'open',
    source: 'mail',
    sourceKey: 'mail:acct:thread',
    accountId: 'acct',
    threadId: 'thread',
    messageId: 'm1',
    title: 'Could you confirm the start date?',
    asker: 'Dana Whitfield',
    due: 'soon',
    pushLevel: 'normal',
    probability: 0.97,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

function record(
  patch: Partial<ObligationRecord> = {},
  viewPatch: Partial<ObligationView> = {},
): ObligationRecord {
  return { obligation: view(viewPatch), sourceMessageId: 'm1', undo: null, draft: null, ...patch };
}

function harness(
  options: {
    record?: ObligationRecord | null;
    flag?: boolean;
    act?: any;
    recordReply?: any;
    cancel?: boolean;
    saveDraft?: () => Promise<unknown>;
    user?: () => Promise<any>;
    limit?: () => Promise<any>;
  } = {},
) {
  const calls: Record<string, any[]> = {};
  const note = (name: string, value: any) => {
    calls[name] = [...(calls[name] ?? []), value];
  };
  const service: ObligationServiceDependencies = {
    flag: (userId) => {
      note('flag', userId);
      return options.flag ?? true;
    },
    get: async (userId, id) => {
      note('get', { userId, id });
      return options.record === undefined ? record() : options.record;
    },
    act: async (input) => {
      note('act', input);
      return options.act ?? { ok: true, obligation: view({ state: 'done' }), undoUntil: NOW + 10_000 };
    },
    recordReply: async (input) => {
      note('recordReply', input);
      if (options.recordReply === 'throw') throw new Error('Convex timeout');
      return (
        options.recordReply ?? {
          ok: true,
          obligation: view({ state: 'done', closeReason: 'sent_reply' }),
          undoUntil: NOW + 10_000,
        }
      );
    },
    saveDraft: async (input) => {
      note('saveDraft', input);
      return options.saveDraft ? options.saveDraft() : { saved: true };
    },
    correctionFor: (target) => {
      note('correctionFor', target);
      return {
        id: 'brief-thread-x',
        scope: 'thread',
        match: target.threadId,
        accountId: target.accountId,
        brief: 'exclude',
      };
    },
    cancelSend: async (userId, pendingId) => {
      note('cancelSend', { userId, pendingId });
      return options.cancel ?? true;
    },
    generateDraft: async (caller, target) => {
      note('generateDraft', { caller, target });
      return { to: ['dana@northwind.test'], cc: [], subject: 'Re: SOW', body: 'Confirmed for November 3.' };
    },
    sendReply: async (caller, target) => {
      note('sendReply', { caller, target });
      return { pendingId: 'outbox:1', fireAt: NOW + 10_000 };
    },
  };
  const deps = {
    requireCurrentUser: (options.user ??
      (async () => ({ userId: 'u1', email: 'owner@example.test', name: 'Owner', source: 'clerk' }))) as any,
    enforceUserRateLimit: (options.limit ?? (async () => undefined)) as any,
    service,
  };
  return { deps, calls };
}

const context = (id = 'ob1') => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) =>
  new NextRequest('http://localhost/api/obligations/ob1', {
    method: 'POST',
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

async function call(route: (req: NextRequest, ctx: any) => Promise<Response>, body?: unknown) {
  const response = await route(post(body), context());
  return { status: response.status, json: await response.json() };
}

describe('POST /api/obligations/[id]: auth and the flag', () => {
  test('no session is 401; over the rate limit is 429', async () => {
    const signedOut = harness({
      user: async () => {
        throw new AuthRequiredError('Sign in first.');
      },
    });
    expect((await call(createObligationActionPost(signedOut.deps), { action: 'done' })).status).toBe(401);
    const limited = harness({
      limit: async () => {
        throw new RateLimitError('Slow down.', 5_000, 60);
      },
    });
    expect((await call(createObligationActionPost(limited.deps), { action: 'done' })).status).toBe(429);
  });

  test('a user outside the flag and an id of another user both get 404', async () => {
    const off = harness({ flag: false });
    expect(await call(createObligationActionPost(off.deps), { action: 'done' })).toEqual({
      status: 404,
      json: { ok: false, error: 'Not found.' },
    });
    expect(off.calls.get).toBeUndefined();
    const missing = harness({ record: null });
    expect((await call(createObligationActionPost(missing.deps), { action: 'done' })).status).toBe(404);
    expect(missing.calls.get).toEqual([{ userId: 'u1', id: 'ob1' }]);
  });

  test('a body that is not an action is 400', async () => {
    const { deps, calls } = harness();
    for (const body of [
      undefined,
      'not json',
      { action: 'snooze' },
      { action: 'later' },
      { action: 'done', extra: 1 },
    ])
      expect((await call(createObligationActionPost(deps), body)).status).toBe(400);
    expect(calls.act).toBeUndefined();
  });
});

describe('POST /api/obligations/[id]: actions', () => {
  test('done returns the closed item and the end of the Undo window', async () => {
    const { deps, calls } = harness();
    const { status, json } = await call(createObligationActionPost(deps), { action: 'done' });
    expect(status).toBe(200);
    expect(json).toEqual({ obligation: view({ state: 'done' }), undoUntil: NOW + 10_000 });
    expect(calls.act).toEqual([{ userId: 'u1', id: 'ob1', action: 'done' }]);
  });

  test('done vs done without a reply: the close reason comes back from the ledger', async () => {
    const { deps } = harness({
      act: {
        ok: true,
        obligation: view({ state: 'done', closeReason: 'user_done_no_reply' }),
        undoUntil: NOW + 10_000,
      },
    });
    const { json } = await call(createObligationActionPost(deps), { action: 'done' });
    expect(json.obligation.closeReason).toBe('user_done_no_reply');
  });

  test('later passes the wake time; a refused time is 400', async () => {
    const { deps, calls } = harness();
    await call(createObligationActionPost(deps), { action: 'later', until: NOW + 3_600_000 });
    expect(calls.act[0]).toEqual({ userId: 'u1', id: 'ob1', action: 'later', until: NOW + 3_600_000 });
    const refused = harness({ act: { ok: false, error: 'invalid' } });
    expect((await call(createObligationActionPost(refused.deps), { action: 'later', until: 1 })).status).toBe(
      400,
    );
  });

  test('Not mine writes the scoped correction of the thread; a code needs none; a row without a thread is 400', async () => {
    const { deps, calls } = harness();
    await call(createObligationActionPost(deps), { action: 'not_mine' });
    expect(calls.correctionFor).toEqual([{ accountId: 'acct', threadId: 'thread', messageId: 'm1' }]);
    expect(calls.act[0]).toMatchObject({
      action: 'not_mine',
      correction: { id: 'brief-thread-x', scope: 'thread', match: 'thread', brief: 'exclude' },
    });
    const code = harness({ record: record({}, { kind: 'code' }) });
    await call(createObligationActionPost(code.deps), { action: 'not_mine' });
    expect(code.calls.correctionFor).toBeUndefined();
    expect(code.calls.act[0].correction).toBeUndefined();
    const threadless = harness({ record: record({}, { accountId: undefined, messageId: undefined }) });
    expect((await call(createObligationActionPost(threadless.deps), { action: 'not_mine' })).status).toBe(
      400,
    );
  });

  test('Undo inside the window; outside it is 409; a closed item is 409', async () => {
    const ok = harness({ act: { ok: true, obligation: view() } });
    const { json } = await call(createObligationActionPost(ok.deps), { action: 'undo' });
    expect(json).toEqual({ obligation: view() });
    expect(ok.calls.act[0]).toEqual({ userId: 'u1', id: 'ob1', action: 'undo' });
    const late = harness({ act: { ok: false, error: 'undo_expired' } });
    expect(await call(createObligationActionPost(late.deps), { action: 'undo' })).toEqual({
      status: 409,
      json: { ok: false, error: 'Undo is no longer available.' },
    });
    const closed = harness({ act: { ok: false, error: 'closed' } });
    expect((await call(createObligationActionPost(closed.deps), { action: 'done' })).status).toBe(409);
    const odd = harness({ act: { ok: false, error: 'mystery' } });
    expect((await call(createObligationActionPost(odd.deps), { action: 'done' })).status).toBe(500);
  });

  test('Undo after Send reply cancels the send first; a reply that went out stays sent', async () => {
    const pending = record({ undo: { until: NOW + 10_000, pendingId: 'outbox:1' } });
    const cancelled = harness({ record: pending, act: { ok: true, obligation: view() } });
    expect((await call(createObligationActionPost(cancelled.deps), { action: 'undo' })).status).toBe(200);
    expect(cancelled.calls.cancelSend).toEqual([{ userId: 'u1', pendingId: 'outbox:1' }]);
    expect(cancelled.calls.act[0]).toEqual({ userId: 'u1', id: 'ob1', action: 'undo', sendCancelled: true });
    const gone = harness({ record: pending, cancel: false });
    expect(await call(createObligationActionPost(gone.deps), { action: 'undo' })).toEqual({
      status: 409,
      json: { ok: false, error: 'The reply already went out.' },
    });
    expect(gone.calls.act).toBeUndefined();
  });

  test('an unexpected fault answers a fixed text', async () => {
    const { deps } = harness();
    deps.service.get = async () => {
      throw new Error('internal detail');
    };
    const original = console.error;
    console.error = () => undefined;
    try {
      const { status, json } = await call(createObligationActionPost(deps), { action: 'done' });
      expect(status).toBe(500);
      expect(json.error).not.toContain('internal detail');
    } finally {
      console.error = original;
    }
  });
});

describe('POST /api/obligations/[id]/draft', () => {
  test('a kept draft comes back with no model call', async () => {
    const draft = { to: ['dana@northwind.test'], cc: [], subject: 'Re: SOW', body: 'Kept.' };
    const { deps, calls } = harness({ record: record({ draft }) });
    expect(await call(createObligationDraftPost(deps))).toEqual({ status: 200, json: { draft } });
    expect(calls.generateDraft).toBeUndefined();
  });

  test('a new draft is made for the reply target and kept; a failed save does not fail the answer', async () => {
    const { deps, calls } = harness({
      saveDraft: async () => {
        throw new Error('Convex busy');
      },
    });
    const { status, json } = await call(createObligationDraftPost(deps));
    expect(status).toBe(200);
    expect(json.draft.body).toBe('Confirmed for November 3.');
    expect(calls.generateDraft[0].target).toEqual({ accountId: 'acct', threadId: 'thread', messageId: 'm1' });
    expect(calls.saveDraft[0]).toMatchObject({ userId: 'u1', id: 'ob1' });
  });

  test('only an open reply has a draft', async () => {
    const action = harness({ record: record({}, { kind: 'action' }) });
    expect((await call(createObligationDraftPost(action.deps))).status).toBe(400);
    const closed = harness({ record: record({}, { state: 'done' }) });
    expect((await call(createObligationDraftPost(closed.deps))).status).toBe(409);
    const off = harness({ flag: false });
    expect((await call(createObligationDraftPost(off.deps))).status).toBe(404);
  });
});

describe('POST /api/obligations/[id]/reply', () => {
  test('the reply goes through the send path and the item closes as sent_reply with Undo', async () => {
    const { deps, calls } = harness();
    const { status, json } = await call(createObligationReplyPost(deps), {
      body: '  Confirmed for November 3.  ',
    });
    expect(status).toBe(200);
    expect(json).toEqual({
      obligation: view({ state: 'done', closeReason: 'sent_reply' }),
      undoUntil: NOW + 10_000,
    });
    expect(calls.sendReply[0].target).toEqual({
      accountId: 'acct',
      threadId: 'thread',
      messageId: 'm1',
      body: 'Confirmed for November 3.',
    });
    expect(calls.recordReply).toEqual([
      { userId: 'u1', id: 'ob1', pendingId: 'outbox:1', fireAt: NOW + 10_000 },
    ]);
  });

  test('after the mail leaves, a failed record still reads as sent, so a retry cannot send twice', async () => {
    for (const recordReply of [{ ok: false, error: 'closed' }, 'throw'] as const) {
      const { deps, calls } = harness({ recordReply });
      const { status, json } = await call(createObligationReplyPost(deps), { body: 'Hi' });
      expect(status).toBe(200);
      expect(calls.sendReply).toHaveLength(1);
      expect(json.obligation).toMatchObject({ id: 'ob1', state: 'done', closeReason: 'sent_reply' });
      expect(json.undoUntil).toBeUndefined();
    }
  });

  test('an empty reply is 400; a closed item is 409; another kind is 400', async () => {
    const { deps, calls } = harness();
    expect((await call(createObligationReplyPost(deps), { body: '   ' })).status).toBe(400);
    expect((await call(createObligationReplyPost(deps), { text: 'hi' })).status).toBe(400);
    expect(calls.sendReply).toBeUndefined();
    const closed = harness({ record: record({}, { state: 'resolved' }) });
    expect((await call(createObligationReplyPost(closed.deps), { body: 'Hi' })).status).toBe(409);
    const code = harness({ record: record({}, { kind: 'code' }) });
    expect((await call(createObligationReplyPost(code.deps), { body: 'Hi' })).status).toBe(400);
    // Only a reply item takes a reply; nothing is sent for an action.
    const action = harness({ record: record({}, { kind: 'action' }) });
    expect((await call(createObligationReplyPost(action.deps), { body: 'Hi' })).status).toBe(400);
    expect(action.calls.sendReply).toBeUndefined();
    const instant = harness({ recordReply: { ok: true, obligation: view({ state: 'done' }) } });
    expect(
      (await call(createObligationReplyPost(instant.deps), { body: 'Hi' })).json.undoUntil,
    ).toBeUndefined();
  });
});

describe('route defaults', () => {
  test('Not mine uses the brief thread correction, so Keep showing in the brief replaces it', () => {
    expect(obligationServiceDefaults.correctionFor({ accountId: 'acct', threadId: 'thread' })).toEqual({
      id: briefThreadCorrectionId('acct', 'thread'),
      scope: 'thread',
      match: 'thread',
      accountId: 'acct',
      brief: 'exclude',
    });
  });

  test('the flag reads LAB86_NEEDS_YOU: all, a list of ids, or off', () => {
    expect(needsYouFlagFor('u1', '')).toBe(false);
    expect(needsYouFlagFor('', 'all')).toBe(false);
    expect(needsYouFlagFor('u1', 'ALL')).toBe(true);
    expect(needsYouFlagFor('u1', 'u0, u1')).toBe(true);
    expect(needsYouFlagFor('u2', 'u0, u1')).toBe(false);
    const previous = process.env.LAB86_NEEDS_YOU;
    process.env.LAB86_NEEDS_YOU = 'u9';
    try {
      expect(obligationServiceDefaults.flag('u9')).toBe(true);
      expect(obligationServiceDefaults.flag('u1')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.LAB86_NEEDS_YOU;
      else process.env.LAB86_NEEDS_YOU = previous;
    }
  });
});

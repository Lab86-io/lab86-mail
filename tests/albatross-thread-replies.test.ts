import { describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { NextRequest } from 'next/server';
import { createAgentStopPost } from '../app/api/agent/stop/route';
import { createThreadsGet } from '../app/api/albatross/threads/route';
import { createThreadSeenPost } from '../app/api/albatross/threads/seen/route';
import { createStepRunPost } from '../app/api/albatross/work/[workId]/run/route';
import { endReply, replyRunning, startReply, stopReply } from '../lib/ai/background-replies';
import {
  appendThreadNote,
  beginThreadReply,
  finishThreadReply,
  replyPreviewText,
  replyWaitsForUser,
  stopThreadReply,
  threadReplyWorkId,
} from '../lib/albatross/thread-replies';
import { AuthRequiredError } from '../lib/auth/current-user';

// Threads that keep working when the user leaves (docs/albatross-threads.md,
// T5, T11), the native thread list routes (T1, T2), and direct steering (T7, T8).

const user = {
  userId: 'user-1',
  email: 'sam.rivera@example.com',
  name: 'Sam Rivera',
  source: 'clerk' as const,
};
const okLimit = async () => ({ ok: true }) as any;

describe('the reply registry', () => {
  test('a newer reply stops the older one; only the current reply ends the entry', () => {
    const first = startReply('u', 'work-abc', 't1');
    const second = startReply('u', 'work-abc', 't2');
    expect(first.signal.aborted).toBe(true);
    endReply('u', 'work-abc', 't1');
    expect(replyRunning('u', 'work-abc')).toBe(true);
    expect(stopReply('u', 'work-abc')).toBe('t2');
    expect(second.signal.aborted).toBe(true);
    expect(stopReply('u', 'work-abc')).toBeNull();
    startReply('u', 'work-xyz', 't3');
    endReply('u', 'work-xyz', 't3');
    expect(replyRunning('u', 'work-xyz')).toBe(false);
  });
});

describe('thread replies', () => {
  test('only a Work thread session with its own Work in the context counts', () => {
    expect(threadReplyWorkId('work-abc123', ['abc123'])).toBe('abc123');
    expect(threadReplyWorkId('work-abc123', ['other'])).toBeNull();
    expect(threadReplyWorkId('work-abc123', ['abc123', 'other'])).toBeNull();
    expect(threadReplyWorkId('chat-1', ['abc123'])).toBeNull();
    expect(threadReplyWorkId(undefined, ['abc123'])).toBeNull();
  });

  test('a reply that ends with a form waits; the preview is its last words', () => {
    const message: any = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'I found two classes.' },
        { type: 'tool-ask_form', toolCallId: 't', state: 'input-available', input: {} },
        { type: 'text', text: '  Which date works?  ' },
      ],
    };
    expect(replyWaitsForUser(message)).toBe(true);
    expect(replyPreviewText(message)).toBe('Which date works?');
    expect(
      replyWaitsForUser({ ...message, parts: [{ type: 'tool-ask_form', state: 'output-available' }] }),
    ).toBe(false);
    expect(replyWaitsForUser(null)).toBe(false);
    expect(replyPreviewText({ id: 'x', role: 'assistant', parts: [] } as any)).toBe('');
  });

  function deps() {
    const calls: Array<[string, any]> = [];
    let controller: AbortController | null = null;
    return {
      calls,
      deps: {
        convexMutation: (async (ref: any, args: any) => {
          calls.push([getFunctionName(ref), args]);
          return null;
        }) as any,
        saveChatSession: (async (...args: any[]) => {
          calls.push(['save', args]);
          return {} as any;
        }) as any,
        startReply: (userId: string, sessionId: string, turn: string) => {
          calls.push(['start', { userId, sessionId, turn }]);
          controller = new AbortController();
          return controller;
        },
        endReply: (userId: string, sessionId: string, turn: string) => {
          calls.push(['end', { userId, sessionId, turn }]);
        },
        stopReply: (userId: string, sessionId: string) => {
          calls.push(['stop', { userId, sessionId }]);
          return sessionId === 'work-abc123' ? 'turn-1' : null;
        },
      },
    };
  }

  const context = {
    userId: 'user-1',
    userEmail: 'sam.rivera@example.com',
    userName: 'Sam Rivera',
    sessionId: 'work-abc123',
    workId: 'abc123',
    turn: 'turn-1',
    baseUpdatedAt: 500,
  };

  test('begin marks the thread; finish saves with the base and tells the list', async () => {
    const { calls, deps: fake } = deps();
    const controller = await beginThreadReply(context, fake);
    expect(controller.signal.aborted).toBe(false);
    expect(calls.map(([name]) => name)).toEqual(['start', 'albatrossThreads:replyStarted']);
    const response: any = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Booked the Monday class.' }],
    };
    await finishThreadReply(
      context,
      { messages: [response], responseMessage: response, isAborted: false },
      fake,
    );
    const save = calls.find(([name]) => name === 'save')![1];
    expect(save[0]).toBe('work-abc123');
    expect(save[3]).toEqual({ kind: 'work', workId: 'abc123' });
    expect(save[4]).toEqual({ baseUpdatedAt: 500 });
    expect(calls.find(([name]) => name === 'albatrossThreads:replyEnded')![1]).toMatchObject({
      workId: 'abc123',
      turn: 'turn-1',
      waits: false,
      preview: 'Booked the Monday class.',
    });
  });

  test('a failed save still ends "answering"; a stopped reply never waits', async () => {
    const { calls, deps: fake } = deps();
    fake.saveChatSession = (async () => {
      throw new Error('kv down');
    }) as any;
    const waiting: any = {
      id: 'a',
      role: 'assistant',
      parts: [{ type: 'tool-ask_form', state: 'input-available' }],
    };
    await expect(
      finishThreadReply(context, { messages: [waiting], responseMessage: waiting, isAborted: true }, fake),
    ).rejects.toThrow(/kv down/);
    expect(calls.find(([name]) => name === 'albatrossThreads:replyEnded')![1].waits).toBe(false);
  });

  test('stop reaches the server reply and clears "answering"', async () => {
    const { calls, deps: fake } = deps();
    expect(
      await stopThreadReply({ userId: 'user-1', sessionId: 'work-abc123', workId: 'abc123' }, fake),
    ).toBe(true);
    expect(calls.find(([name]) => name === 'albatrossThreads:replyEnded')![1]).toMatchObject({
      turn: 'turn-1',
      waits: false,
    });
    expect(await stopThreadReply({ userId: 'user-1', sessionId: 'work-none', workId: 'none' }, fake)).toBe(
      false,
    );
  });
});

const json = (body: unknown) =>
  new Request('https://mail.lab86.io/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('routes', () => {
  test('POST /api/agent/stop takes a thread session id only', async () => {
    const stopped: any[] = [];
    const post = createAgentStopPost({
      requireCurrentUser: async () => user,
      enforceUserRateLimit: okLimit,
      stopThreadReply: async (input: any) => {
        stopped.push(input);
        return true;
      },
    } as any);
    expect(await (await post(json({ sessionId: 'work-abc123' }))).json()).toEqual({
      ok: true,
      stopped: true,
    });
    expect(stopped[0]).toEqual({ userId: 'user-1', sessionId: 'work-abc123', workId: 'abc123' });
    expect((await post(json({ sessionId: 'chat-1' }))).status).toBe(400);
    const unauth = createAgentStopPost({
      requireCurrentUser: async () => {
        throw new AuthRequiredError('Sign in required.');
      },
    } as any);
    expect((await unauth(json({ sessionId: 'work-abc123' }))).status).toBe(401);
  });

  test('GET /api/albatross/threads merges the Work list and the activity', async () => {
    const get = createThreadsGet({
      requireCurrentUser: async () => user,
      enforceUserRateLimit: okLimit,
      convexQuery: (async (ref: any) =>
        getFunctionName(ref) === 'albatrossWorkV2:allWork'
          ? [{ _id: 'w1', title: 'Renew the car registration', workState: 'active', updatedAt: 1 }]
          : {
              runs: {},
              threads: {
                w1: {
                  answering: true,
                  answeringSince: 2,
                  replyAt: null,
                  replyWaits: false,
                  replyPreview: null,
                  seenAt: null,
                },
              },
              now: 5,
            }) as any,
    } as any);
    const answer = await get();
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(await answer.json()).toMatchObject({
      ok: true,
      now: 5,
      threads: [{ workId: 'w1', status: 'answering' }],
    });
  });

  test('POST /api/albatross/threads/seen marks a real Work only', async () => {
    const post = createThreadSeenPost({
      requireCurrentUser: async () => user,
      enforceUserRateLimit: okLimit,
      convexMutation: (async (_ref: any, args: any) => {
        if (args.workId === 'missing') throw new Error('Work not found.');
        return { seenAt: 9 };
      }) as any,
    } as any);
    expect(await (await post(json({ workId: 'w1' }))).json()).toEqual({ ok: true, seenAt: 9 });
    expect((await post(json({ workId: 'missing' }))).status).toBe(404);
    expect((await post(json({ workId: 'bad id' }))).status).toBe(400);
  });

  test('the run route: steer carries the note id; redirect stops and starts again with the note', async () => {
    const calls: Array<[string, any]> = [];
    const post = createStepRunPost({
      requireCurrentUser: async () => user,
      enforceUserRateLimit: okLimit,
      convexMutation: (async (ref: any, args: any) => {
        const name = getFunctionName(ref);
        calls.push([name, args]);
        if (name === 'albatrossStepRuns:cancel')
          return { cancelled: args.id !== 'ended', browserSessionId: null };
        return true;
      }) as any,
      resumeStepRun: (async (input: any) => {
        calls.push(['resume', input]);
        return { runId: 'run-2', created: true };
      }) as any,
      appendThreadNote: (async (input: any) => {
        calls.push(['append', input]);
        return input.noteId || 'generated';
      }) as any,
    });
    const request = (body: unknown) =>
      new NextRequest('https://mail.lab86.io/api/albatross/work/w1/run', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    const ctx = { params: Promise.resolve({ workId: 'w1' }) };
    expect(
      await (
        await post(request({ action: 'steer', runId: 'run-1', note: 'Use Monday', noteId: 'm1' }), ctx)
      ).json(),
    ).toEqual({
      ok: true,
      runId: 'run-1',
      messageId: 'm1',
    });
    expect(calls[0][1]).toMatchObject({ id: 'run-1', text: 'Use Monday', noteId: 'm1' });
    expect(calls.find(([name]) => name === 'append')![1]).toMatchObject({
      workId: 'w1',
      runId: 'run-1',
      note: 'Use Monday',
      noteId: 'm1',
    });
    const redirected = await post(
      request({ action: 'redirect', runId: 'run-1', note: `SSN ${['123', '-45-', '6789'].join('')}` }),
      ctx,
    );
    expect(await redirected.json()).toEqual({ ok: true, runId: 'run-2', messageId: 'generated' });
    expect(calls.filter(([name]) => name === 'append').at(-1)![1]).toMatchObject({
      runId: 'run-2',
      redirect: true,
    });
    expect(calls.find(([name]) => name === 'resume')![1]).toEqual({
      userId: 'user-1',
      workId: 'w1',
      runId: 'run-1',
      note: 'SSN [removed: looks like a Social Security number]',
    });
    expect((await post(request({ action: 'redirect', runId: 'ended', note: 'x' }), ctx)).status).toBe(409);
    expect((await post(request({ action: 'redirect', runId: 'run-1' }), ctx)).status).toBe(400);
  });
});

test('appendThreadNote saves one user message with steer metadata and keeps every stored message', async () => {
  const saved: any[] = [];
  const id = await appendThreadNote(
    { userId: 'user-1', workId: 'abc123', runId: 'run-1', note: 'Use the Monday class', noteId: 'm1' },
    { saveChatSession: (async (...args: any[]) => saved.push(args)) as any },
  );
  expect(id).toBe('m1');
  expect(saved[0][0]).toBe('work-abc123');
  expect(saved[0][1][0]).toMatchObject({
    id: 'm1',
    role: 'user',
    parts: [{ type: 'text', text: 'Use the Monday class' }],
    metadata: { steer: { runId: 'run-1' } },
  });
  expect(saved[0][4]).toEqual({ baseUpdatedAt: 0 });
  const generated = await appendThreadNote(
    { userId: 'user-1', workId: 'abc123', runId: 'run-2', note: 'Go back', redirect: true },
    { saveChatSession: (async (...args: any[]) => saved.push(args)) as any },
  );
  expect(generated).toMatch(/^note-run-2-/);
  expect(saved[1][1][0].metadata.steer).toEqual({ runId: 'run-2', redirect: true });
});

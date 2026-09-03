import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createAlbatrossCapturePost, isChatCaptureBody } from '../app/api/albatross/capture/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { RateLimitError } from '../lib/rate-limit';

function request(body: unknown) {
  return new NextRequest('http://localhost/api/albatross/capture', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function dependencies() {
  const rateLimitCalls: Array<Record<string, unknown>> = [];
  const captureCalls: any[] = [];
  const chatCalls: any[] = [];
  const deps = {
    requireCurrentUser: async () => ({
      userId: 'user_capture',
      email: 'owner@example.test',
      name: 'Owner',
      source: 'clerk' as const,
    }),
    enforceUserRateLimit: async (input: Record<string, unknown>) => {
      rateLimitCalls.push(input);
      return { ok: true };
    },
    captureWork: async (input: any) => {
      captureCalls.push(input);
      return { captureId: 'capture-1', status: 'split' as const, workIds: ['work-1'] };
    },
    captureFromChat: async (input: any) => {
      chatCalls.push(input);
      return {
        captureId: 'capture-2',
        workIds: ['work-2'],
        work: [{ id: 'work-2', title: 'Book the dentist', shape: 'quick', horizon: null }],
        existing: chatCalls.length > 1,
      };
    },
  };
  return { deps: deps as any, rateLimitCalls, captureCalls, chatCalls };
}

describe('isChatCaptureBody', () => {
  test('needs source chat and a conversation id', () => {
    expect(isChatCaptureBody({ source: 'chat', conversationId: 'conv-1' })).toBe(true);
    expect(isChatCaptureBody({ source: 'chat' })).toBe(false);
    expect(isChatCaptureBody({ source: 'text', conversationId: 'conv-1' })).toBe(false);
    expect(isChatCaptureBody({ source: 'chat', conversationId: '  ' })).toBe(false);
  });
});

describe('POST /api/albatross/capture', () => {
  test('keeps the sheet path: rawText goes to captureWork under the 30/min limit', async () => {
    const { deps, rateLimitCalls, captureCalls, chatCalls } = dependencies();
    const response = await createAlbatrossCapturePost(deps)(
      request({
        rawText: ' renew the passport ',
        source: 'voice',
        transcript: 'renew the passport',
        areaId: 'area-1',
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      captureId: 'capture-1',
      status: 'split',
      workIds: ['work-1'],
    });
    expect(rateLimitCalls).toEqual([
      { userId: 'user_capture', key: 'albatross-capture-v2', limit: 30, windowMs: 60_000 },
    ]);
    expect(captureCalls).toEqual([
      {
        rawText: 'renew the passport',
        transcript: 'renew the passport',
        source: 'voice',
        areaId: 'area-1',
        reviewedItems: undefined,
      },
    ]);
    expect(chatCalls).toHaveLength(0);
  });

  test('source chat without a conversation stays on the sheet path (brief and area callers)', async () => {
    const { deps, captureCalls, chatCalls } = dependencies();
    await createAlbatrossCapturePost(deps)(
      request({ rawText: 'plan the trip', source: 'chat', areaId: 'area-2' }),
    );
    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0]).toMatchObject({ source: 'chat', areaId: 'area-2' });
    expect(chatCalls).toHaveLength(0);
  });

  test('a Hold from a reply sends text, reply, conversation, and message to captureFromChat', async () => {
    const { deps, captureCalls, chatCalls } = dependencies();
    const response = await createAlbatrossCapturePost(deps)(
      request({
        text: 'book the dentist before the trip',
        source: 'chat',
        conversationId: 'conv-1',
        sourceMessageId: 'msg-3',
        replyText: '1. Call the office\n2. Pick a date',
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: 'split',
      captureId: 'capture-2',
      workIds: ['work-2'],
      work: [{ id: 'work-2', title: 'Book the dentist', shape: 'quick', horizon: null }],
      existing: false,
    });
    expect(captureCalls).toHaveLength(0);
    expect(chatCalls).toEqual([
      {
        text: 'book the dentist before the trip',
        replyText: '1. Call the office\n2. Pick a date',
        conversationId: 'conv-1',
        sourceMessageId: 'msg-3',
      },
    ]);
  });

  test('a second Hold on the same reply reports the existing Work', async () => {
    const { deps } = dependencies();
    const post = createAlbatrossCapturePost(deps);
    const body = {
      text: 'plan the move',
      source: 'chat',
      conversationId: 'conv-1',
      sourceMessageId: 'msg-1',
    };
    await post(request(body));
    const second = await (await post(request(body))).json();
    expect(second.existing).toBe(true);
    expect(second.workIds).toEqual(['work-2']);
  });

  test('rejects invalid json and empty text', async () => {
    const { deps } = dependencies();
    const post = createAlbatrossCapturePost(deps);
    expect((await post(request('{'))).status).toBe(400);
    expect((await post(request({ text: '  ', source: 'chat', conversationId: 'c' }))).status).toBe(400);
    expect((await post(request({}))).status).toBe(400);
  });

  test('maps auth, rate limit, and capture failures', async () => {
    const auth = dependencies();
    auth.deps.requireCurrentUser = async () => {
      throw new AuthRequiredError('auth required');
    };
    expect((await createAlbatrossCapturePost(auth.deps)(request({ rawText: 'x' }))).status).toBe(401);

    const limited = dependencies();
    limited.deps.enforceUserRateLimit = async () => {
      throw new RateLimitError('Too many requests.', 1_000, 30);
    };
    expect((await createAlbatrossCapturePost(limited.deps)(request({ rawText: 'x' }))).status).toBe(429);

    const failed = dependencies();
    failed.deps.captureFromChat = async () => {
      throw new Error('split failed');
    };
    const response = await createAlbatrossCapturePost(failed.deps)(
      request({ text: 'x', source: 'chat', conversationId: 'c' }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'split failed' });
  });
});

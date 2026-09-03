import { describe, expect, test } from 'bun:test';
import { createMobileAssistantRoutePost } from '../app/api/mobile/v1/assistant/route/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { executeMobileCommand, mobileCommandDomain } from '../lib/mobile/v1/command-executor';
import {
  AssistantRouteRequestSchema,
  AssistantRouteVerdictSchema,
  MobileCommandSchema,
  SyncChangeSchema,
} from '../lib/mobile/v1/contract';
import { mobileOpenAPIV1 } from '../lib/mobile/v1/openapi';
import { RateLimitError } from '../lib/rate-limit';

const user = {
  userId: 'user_ask_hold',
  email: 'owner@example.com',
  name: 'Owner',
  source: 'clerk' as const,
};

const createdAt = '2026-09-03T09:00:00.000Z';

function command(kind: string, payload: Record<string, unknown>, idempotencyKey = `${kind}-1`) {
  return MobileCommandSchema.parse({ idempotencyKey, kind, payload, clientCreatedAt: createdAt });
}

describe('work.captureFromChat command', () => {
  test('parses, names the work domain, and rejects payload drift', () => {
    const parsed = command('work.captureFromChat', {
      text: 'plan the move',
      conversationID: 'conv-1',
      sourceMessageID: 'msg-1',
      replyText: '1. Book movers',
    });
    expect(parsed.kind).toBe('work.captureFromChat');
    expect(mobileCommandDomain(parsed)).toBe('work');
    expect(() => command('work.captureFromChat', { text: 'x' })).toThrow();
    expect(() => command('work.captureFromChat', { text: 'x', conversationID: 'c', extra: 1 })).toThrow();
  });

  test('runs captureFromChat and reports a workCaptured sync change', async () => {
    const calls: any[] = [];
    const deps = {
      captureFromChat: async (input: any) => {
        calls.push(input);
        return { captureId: 'capture-4', workIds: ['work-4', 'work-5'], work: [], existing: false };
      },
    } as any;
    const result = await executeMobileCommand(
      command('work.captureFromChat', {
        text: 'plan the move',
        conversationID: 'conv-1',
        sourceMessageID: 'msg-1',
        replyText: '1. Book movers',
      }),
      user,
      deps,
    );
    expect(calls).toEqual([
      {
        text: 'plan the move',
        replyText: '1. Book movers',
        conversationId: 'conv-1',
        sourceMessageId: 'msg-1',
      },
    ]);
    expect(result).toEqual({
      status: 'applied',
      syncDomain: 'work',
      entityKind: 'workCaptured',
      entityID: 'work-4',
      syncPayload: { workIDs: ['work-4', 'work-5'], existing: false },
    });
  });

  test('a repeated Hold reports existing and keeps the first Work id', async () => {
    const deps = {
      captureFromChat: async () => ({
        captureId: 'capture-4',
        workIds: ['work-4'],
        work: [],
        existing: true,
      }),
    } as any;
    const result = await executeMobileCommand(
      command('work.captureFromChat', {
        text: 'plan the move',
        conversationID: 'conv-1',
        sourceMessageID: 'msg-1',
      }),
      user,
      deps,
    );
    expect(result).toMatchObject({
      entityID: 'work-4',
      syncPayload: { workIDs: ['work-4'], existing: true },
    });
  });

  test('the workCaptured sync change decodes through the public contract', () => {
    const change = SyncChangeSchema.parse({
      revision: 12,
      operation: 'upsert',
      domain: 'work',
      entityKind: 'workCaptured',
      entityID: 'work-4',
      payload: { workIDs: ['work-4'], existing: false },
    });
    expect(change.entityKind).toBe('workCaptured');
  });

  test('the OpenAPI document lists the command, the sync change, and the route path', () => {
    const document = mobileOpenAPIV1();
    expect(document.components.schemas.MobileCommand.discriminator.mapping['work.captureFromChat']).toBe(
      '#/components/schemas/WorkCaptureFromChatCommand',
    );
    expect(document.components.schemas.SyncChange.discriminator.mapping.workCaptured).toBe(
      '#/components/schemas/WorkCapturedSyncChange',
    );
    expect(document.paths['/api/mobile/v1/assistant/route'].post.operationId).toBe('postAssistantRoute');
    expect(document.components.schemas.AssistantRouteVerdict).toBeDefined();
  });
});

describe('assistant route schemas', () => {
  test('bound the request text and the verdict', () => {
    expect(AssistantRouteRequestSchema.safeParse({ text: 'x'.repeat(2_001) }).success).toBe(false);
    expect(AssistantRouteRequestSchema.safeParse({ text: '  ' }).success).toBe(false);
    expect(AssistantRouteVerdictSchema.safeParse({ route: 'hold', confidence: 0.6 }).success).toBe(true);
    expect(AssistantRouteVerdictSchema.safeParse({ route: 'maybe', confidence: 0.6 }).success).toBe(false);
  });
});

function routeRequest(body: unknown) {
  return new Request('http://localhost/api/mobile/v1/assistant/route', {
    method: 'POST',
    headers: { 'x-request-id': 'req-route' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function routeDependencies() {
  const rateLimitCalls: any[] = [];
  const classifyCalls: any[] = [];
  const deps = {
    requireCurrentUser: async () => user,
    enforceUserRateLimit: async (input: any) => {
      rateLimitCalls.push(input);
      return { ok: true };
    },
    classifyRoute: async (input: any) => {
      classifyCalls.push(input);
      return { route: 'hold' as const, confidence: 0.8 };
    },
    now: () => 1_700_000_000_000,
  };
  return { deps: deps as any, rateLimitCalls, classifyCalls };
}

describe('POST /api/mobile/v1/assistant/route', () => {
  test('returns the verdict with the request id under the albatross-route limit', async () => {
    const { deps, rateLimitCalls, classifyCalls } = routeDependencies();
    const response = await createMobileAssistantRoutePost(deps)(routeRequest({ text: ' book the dentist ' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('req-route');
    expect(await response.json()).toEqual({ route: 'hold', confidence: 0.8 });
    expect(rateLimitCalls).toEqual([
      { userId: 'user_ask_hold', key: 'albatross-route', limit: 60, windowMs: 60_000 },
    ]);
    expect(classifyCalls).toEqual([
      { text: 'book the dentist', nowMs: 1_700_000_000_000, userId: 'user_ask_hold' },
    ]);
  });

  test('maps invalid bodies, auth, and rate limits to the mobile error envelope', async () => {
    const { deps } = routeDependencies();
    const post = createMobileAssistantRoutePost(deps);
    const invalid = await post(routeRequest({ text: '' }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe('INVALID_REQUEST');
    expect((await post(routeRequest('{'))).status).toBe(400);

    const auth = routeDependencies();
    auth.deps.requireCurrentUser = async () => {
      throw new AuthRequiredError('auth required');
    };
    expect((await createMobileAssistantRoutePost(auth.deps)(routeRequest({ text: 'hi' }))).status).toBe(401);

    const limited = routeDependencies();
    limited.deps.enforceUserRateLimit = async () => {
      throw new RateLimitError('Too many requests.', 1_000, 60);
    };
    const response = await createMobileAssistantRoutePost(limited.deps)(routeRequest({ text: 'hi' }));
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe('RATE_LIMITED');
  });
});

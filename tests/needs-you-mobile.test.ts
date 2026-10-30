import { describe, expect, spyOn, test } from 'bun:test';
import type { z } from 'zod';
import { POST as albatrossPost } from '../app/api/mobile/v1/needs-you/[id]/albatross/route';
import { POST as draftPost } from '../app/api/mobile/v1/needs-you/[id]/draft/route';
import { POST as replyPost } from '../app/api/mobile/v1/needs-you/[id]/reply/route';
import { POST as actionPost } from '../app/api/mobile/v1/needs-you/[id]/route';
import { GET as snapshotGet } from '../app/api/mobile/v1/needs-you/route';
import { mobileNeedsYouDefaults } from '../app/api/mobile/v1/needs-you/shared';
import { AuthRequiredError } from '../lib/auth/current-user';
import {
  NeedsYouSnapshotSchema,
  ObligationActionRequestSchema,
  ObligationAlbatrossResponseSchema,
  ObligationReplyRequestSchema,
  ObligationViewSchema,
} from '../lib/mobile/v1/contract';
import {
  contractJSON,
  createMobileNeedsYouActionPost,
  createMobileNeedsYouAlbatrossPost,
  createMobileNeedsYouDraftPost,
  createMobileNeedsYouGet,
  createMobileNeedsYouReplyPost,
  type MobileNeedsYouDependencies,
  mobileObligationErrorResponse,
} from '../lib/mobile/v1/needs-you';
import { mobileOpenAPIV1 } from '../lib/mobile/v1/openapi';
import type { ObligationAlbatrossDependencies } from '../lib/obligations/albatross';
import type {
  NeedsYouSnapshot,
  ObligationAlbatrossResponse,
  ObligationView,
} from '../lib/obligations/contract';
import { ObligationApiError, type ObligationServiceDependencies } from '../lib/obligations/service';
import { RateLimitError } from '../lib/rate-limit';

// Needs you for the native apps (phase 5, S2). Invented people and companies only.

const NOW = Date.parse('2026-10-30T15:00:00Z');

// The mobile schemas and the shared contract are the same shapes, both ways.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const viewSame: Same<z.infer<typeof ObligationViewSchema>, ObligationView> = true;
const snapshotSame: Same<z.infer<typeof NeedsYouSnapshotSchema>, NeedsYouSnapshot> = true;
const albatrossSame: Same<
  z.infer<typeof ObligationAlbatrossResponseSchema>,
  ObligationAlbatrossResponse
> = true;

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

function harness(
  options: {
    flag?: boolean;
    snapshot?: NeedsYouSnapshot;
    record?: ObligationView | null;
    user?: () => Promise<any>;
    limit?: (input: any) => Promise<void>;
  } = {},
) {
  const calls: Record<string, any[]> = {};
  const note = (name: string, value: any) => {
    calls[name] = [...(calls[name] ?? []), value];
  };
  const record = () => {
    const obligation = options.record === undefined ? view() : options.record;
    return obligation ? { obligation, sourceMessageId: 'm1', undo: null, draft: null } : null;
  };
  const service: ObligationServiceDependencies = {
    flag: () => options.flag ?? true,
    get: async () => record(),
    act: async (input) => {
      note('act', input);
      return {
        ok: true,
        obligation: view({ state: 'done', closeReason: 'user_done' }),
        undoUntil: NOW + 10_000,
      };
    },
    recordReply: async () => ({
      ok: true,
      obligation: view({ state: 'done', closeReason: 'sent_reply' }),
      undoUntil: NOW + 10_000,
    }),
    saveDraft: async () => ({ saved: true }),
    correctionFor: (target) => ({
      id: 'brief-thread-x',
      scope: 'thread',
      match: target.threadId,
      accountId: target.accountId,
      brief: 'exclude',
    }),
    cancelSend: async () => true,
    generateDraft: async () => ({
      to: ['dana@northwind.test'],
      cc: [],
      subject: 'Re: SOW',
      body: 'Confirmed for November 3.',
    }),
    sendReply: async (_caller, target) => {
      note('sendReply', target);
      return { pendingId: 'outbox:1', fireAt: NOW + 10_000 };
    },
  };
  const albatross: ObligationAlbatrossDependencies = {
    flag: () => options.flag ?? true,
    get: async () => record(),
    link: async (input) => ({
      ok: true,
      obligation: view({ workId: input.workId, workTitle: 'SOW' }),
      workTitle: 'SOW',
    }),
    runs: async () => [],
    steer: async () => true,
    startRun: async () => ({ runId: 'run-1' }),
    capture: async () => ({ workIds: ['work-new'] }),
  };
  const deps: MobileNeedsYouDependencies = {
    requireCurrentUser: (options.user ??
      (async () => ({ userId: 'u1', email: 'owner@example.test', name: 'Owner', source: 'clerk' }))) as any,
    enforceUserRateLimit: (async (input: any) => {
      note('limit', input);
      await options.limit?.(input);
    }) as any,
    flag: (userId) => {
      note('flag', userId);
      return options.flag ?? true;
    },
    snapshot: async (userId) => {
      note('snapshot', userId);
      return options.snapshot ?? { enabled: true, timezone: 'America/New_York', items: [view()] };
    },
    service,
    albatross,
  };
  return { deps, calls };
}

const context = { params: Promise.resolve({ id: 'ob1' }) };
const get = () =>
  new Request('http://localhost/api/mobile/v1/needs-you', { headers: { 'x-request-id': 'req-1' } });
const post = (path: string, body?: unknown) =>
  new Request(`http://localhost/api/mobile/v1/needs-you/ob1${path}`, {
    method: 'POST',
    headers: { 'x-request-id': 'req-1' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

async function read(response: Response) {
  return {
    status: response.status,
    json: await response.json(),
    requestID: response.headers.get('x-request-id'),
  };
}

describe('GET /api/mobile/v1/needs-you', () => {
  test('the contract shapes match the shared types', () => {
    expect([viewSame, snapshotSame, albatrossSame]).toEqual([true, true, true]);
  });

  test('no session is 401 and over the rate limit is 429, in the mobile envelope', async () => {
    const signedOut = harness({
      user: async () => {
        throw new AuthRequiredError('Sign in first.');
      },
    });
    expect(await read(await createMobileNeedsYouGet(signedOut.deps)(get()))).toEqual({
      status: 401,
      requestID: 'req-1',
      json: {
        ok: false,
        requestID: 'req-1',
        error: { code: 'AUTH_REQUIRED', message: 'Sign in first.', retryable: false },
      },
    });
    const limited = harness({
      limit: async () => {
        throw new RateLimitError('Slow down.', 5_000, 120);
      },
    });
    const response = await read(await createMobileNeedsYouGet(limited.deps)(get()));
    expect(response.status).toBe(429);
    expect(response.json.error.code).toBe('RATE_LIMITED');
  });

  test('outside the flag: enabled false with no Convex read', async () => {
    const { deps, calls } = harness({ flag: false });
    expect((await read(await createMobileNeedsYouGet(deps)(get()))).json).toEqual({
      enabled: false,
      timezone: 'UTC',
      items: [],
    });
    expect(calls.snapshot).toBeUndefined();
    expect(calls.limit).toEqual([{ userId: 'u1', key: 'needs-you-snapshot', limit: 120, windowMs: 60_000 }]);
  });

  test('in the flag: the snapshot JSON, field for field, without keys outside the contract', async () => {
    const extra = {
      ...view({ code: { value: '482913', issuer: 'Northwind', expiresAt: NOW + 60_000 } }),
      secretRow: 1,
    };
    const { deps } = harness({
      snapshot: { enabled: true, timezone: 'America/New_York', items: [extra as any] },
    });
    const { status, json } = await read(await createMobileNeedsYouGet(deps)(get()));
    expect(status).toBe(200);
    expect(json).toEqual({
      enabled: true,
      timezone: 'America/New_York',
      items: [view({ code: { value: '482913', issuer: 'Northwind', expiresAt: NOW + 60_000 } })],
    });
  });

  test('a ledger that is not on yet reads as enabled false, with the time zone', async () => {
    const { deps } = harness({ snapshot: { enabled: false, timezone: 'Europe/Berlin', items: [view()] } });
    expect((await read(await createMobileNeedsYouGet(deps)(get()))).json).toEqual({
      enabled: false,
      timezone: 'Europe/Berlin',
      items: [],
    });
    const blank = harness({ snapshot: { enabled: false, timezone: '', items: [] } });
    expect((await read(await createMobileNeedsYouGet(blank.deps)(get()))).json.timezone).toBe('UTC');
  });
});

describe('POST /api/mobile/v1/needs-you/[id]', () => {
  test('done gives ObligationActionResponse through the web service', async () => {
    const { deps, calls } = harness();
    const { status, json } = await read(
      await createMobileNeedsYouActionPost(deps)(post('', { action: 'done' }), context),
    );
    expect(status).toBe(200);
    expect(json).toEqual({
      obligation: view({ state: 'done', closeReason: 'user_done' }),
      undoUntil: NOW + 10_000,
    });
    expect(calls.act).toEqual([{ userId: 'u1', id: 'ob1', action: 'done' }]);
    expect(calls.limit[0]).toMatchObject({ key: 'obligation-action', limit: 60 });
  });

  test('a body that is not an action is 400; outside the flag is 404', async () => {
    const { deps, calls } = harness();
    for (const body of [undefined, 'not json', { action: 'snooze' }, { action: 'later' }]) {
      const { status, json } = await read(
        await createMobileNeedsYouActionPost(deps)(post('', body), context),
      );
      expect(status).toBe(400);
      expect(json.error.code).toBe('INVALID_REQUEST');
    }
    expect(calls.act).toBeUndefined();
    const off = harness({ flag: false });
    const { status, json } = await read(
      await createMobileNeedsYouActionPost(off.deps)(post('', { action: 'done' }), context),
    );
    expect(status).toBe(404);
    expect(json.error).toEqual({ code: 'NOT_FOUND', message: 'Not found.', retryable: false });
  });
});

describe('POST /api/mobile/v1/needs-you/[id] with an RSVP (integration)', () => {
  test('{ action: rsvp, response } reaches the calendar answer, and the OpenAPI body names it', async () => {
    const { deps, calls } = harness();
    const invitation = view({
      kind: 'rsvp',
      source: 'calendar',
      sourceKey: 'calendar:acct:evt-1',
      eventId: 'evt-1',
      eventStart: NOW + 86_400_000,
      threadId: undefined,
      messageId: undefined,
    });
    const answers: unknown[] = [];
    const service: ObligationServiceDependencies = {
      ...deps.service,
      get: async () => ({
        obligation: invitation,
        sourceMessageId: null,
        calendarId: 'primary',
        undo: null,
        draft: null,
      }),
      rsvp: async (_caller, target) => {
        answers.push(target);
      },
    };
    const { status, json } = await read(
      await createMobileNeedsYouActionPost({ ...deps, service })(
        post('', { action: 'rsvp', response: 'yes' }),
        context,
      ),
    );
    expect(status).toBe(200);
    expect(json.obligation.id).toBe('ob1');
    expect(answers).toEqual([
      { accountId: 'acct', calendarId: 'primary', eventId: 'evt-1', response: 'yes' },
    ]);
    expect(calls.act).toEqual([{ userId: 'u1', id: 'ob1', action: 'rsvp' }]);
    // An answer that is not yes, no, or maybe is 400 in the envelope.
    const bad = await read(
      await createMobileNeedsYouActionPost({ ...deps, service })(
        post('', { action: 'rsvp', response: 'sure' }),
        context,
      ),
    );
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ ok: false, requestID: 'req-1', error: { code: 'INVALID_REQUEST' } });
    const schemas = (mobileOpenAPIV1() as any).components.schemas;
    expect(schemas.ObligationActionRequest.properties.action.enum).toContain('rsvp');
    expect(schemas.ObligationActionRequest.properties.response.enum).toEqual(['yes', 'no', 'maybe']);
  });
});

describe('POST /api/mobile/v1/needs-you/[id]/draft and /reply', () => {
  test('the draft of a reply item; another kind is 400', async () => {
    const { deps } = harness();
    const { status, json } = await read(await createMobileNeedsYouDraftPost(deps)(post('/draft'), context));
    expect(status).toBe(200);
    expect(json).toEqual({
      draft: { to: ['dana@northwind.test'], cc: [], subject: 'Re: SOW', body: 'Confirmed for November 3.' },
    });
    const action = harness({ record: view({ kind: 'action' }) });
    expect((await createMobileNeedsYouDraftPost(action.deps)(post('/draft'), context)).status).toBe(400);
  });

  test('the reply sends and closes the item; an empty reply is 400; a closed item is 409', async () => {
    const { deps, calls } = harness();
    const { status, json } = await read(
      await createMobileNeedsYouReplyPost(deps)(
        post('/reply', { body: 'Confirmed for November 3.' }),
        context,
      ),
    );
    expect(status).toBe(200);
    expect(json).toEqual({
      obligation: view({ state: 'done', closeReason: 'sent_reply' }),
      undoUntil: NOW + 10_000,
    });
    expect(calls.sendReply).toEqual([
      { accountId: 'acct', threadId: 'thread', messageId: 'm1', body: 'Confirmed for November 3.' },
    ]);
    expect((await createMobileNeedsYouReplyPost(deps)(post('/reply', { body: '  ' }), context)).status).toBe(
      400,
    );
    const closed = harness({ record: view({ state: 'done', closeReason: 'user_done', closedAt: NOW }) });
    const conflict = await read(
      await createMobileNeedsYouReplyPost(closed.deps)(post('/reply', { body: 'Hi' }), context),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe('CONFLICT');
  });
});

describe('POST /api/mobile/v1/needs-you/[id]/albatross', () => {
  test('gives ObligationAlbatrossResponse; outside the flag is 404', async () => {
    const { deps } = harness();
    const { status, json } = await read(
      await createMobileNeedsYouAlbatrossPost(deps)(post('/albatross'), context),
    );
    expect(status).toBe(200);
    expect(json).toEqual({
      workId: 'work-new',
      created: true,
      obligation: view({ workId: 'work-new', workTitle: 'SOW' }),
    });
    const off = harness({ flag: false });
    expect((await createMobileNeedsYouAlbatrossPost(off.deps)(post('/albatross'), context)).status).toBe(404);
  });
});

describe('the mobile error envelope and the contract JSON', () => {
  test('a service error keeps its status; the code follows it', async () => {
    const cases: Array<[number, string, boolean]> = [
      [400, 'INVALID_REQUEST', false],
      [403, 'FORBIDDEN', false],
      [404, 'NOT_FOUND', false],
      [409, 'CONFLICT', false],
      [429, 'RATE_LIMITED', true],
      [418, 'INVALID_REQUEST', false],
      [502, 'SERVER_ERROR', true],
    ];
    for (const [status, code, retryable] of cases) {
      const response = await read(
        mobileObligationErrorResponse(new ObligationApiError('Message.', status), 'r'),
      );
      expect(response).toEqual({
        status,
        requestID: 'r',
        json: { ok: false, requestID: 'r', error: { code, message: 'Message.', retryable } },
      });
    }
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const other = await read(mobileObligationErrorResponse(new Error('private detail'), 'r'));
      expect(other.status).toBe(500);
      expect(JSON.stringify(other.json)).not.toContain('private detail');
    } finally {
      error.mockRestore();
    }
  });

  test('a value outside the schema keeps its keys and is logged', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const odd = { ...view(), createdAt: 1.5 };
      expect(contractJSON(ObligationViewSchema, odd, 'view')).toBe(odd);
      expect(warn).toHaveBeenCalledWith('[mobile needs-you] a response does not match the contract', {
        label: 'view',
        paths: ['createdAt'],
      });
    } finally {
      warn.mockRestore();
    }
  });

  test('the request schemas name the same fields as ObligationAction and the reply body', () => {
    for (const body of [
      { action: 'done' },
      { action: 'later', until: NOW + 60_000 },
      { action: 'not_mine' },
      { action: 'undo' },
      { action: 'rsvp', response: 'maybe' },
    ])
      expect(ObligationActionRequestSchema.parse(body)).toEqual(body as any);
    expect(() => ObligationActionRequestSchema.parse({ action: 'done', extra: 1 })).toThrow();
    expect(ObligationReplyRequestSchema.parse({ body: ' Hi ' })).toEqual({ body: 'Hi' });
  });
});

describe('the routes and the OpenAPI document', () => {
  test('the route files use the real dependencies', () => {
    for (const handler of [snapshotGet, actionPost, draftPost, replyPost, albatrossPost])
      expect(typeof handler).toBe('function');
    const previous = process.env.LAB86_NEEDS_YOU;
    try {
      process.env.LAB86_NEEDS_YOU = 'u1,u2';
      expect(mobileNeedsYouDefaults.flag('u2')).toBe(true);
      expect(mobileNeedsYouDefaults.flag('u3')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.LAB86_NEEDS_YOU;
      else process.env.LAB86_NEEDS_YOU = previous;
    }
  });

  test('every route and schema is in the document, with a path id and a 404', () => {
    const document = mobileOpenAPIV1() as any;
    expect(document.paths['/api/mobile/v1/needs-you'].get.operationId).toBe('getMobileNeedsYou');
    const operations: Array<[string, string, string | null, string]> = [
      [
        '/api/mobile/v1/needs-you/{id}',
        'postMobileNeedsYouAction',
        'ObligationActionRequest',
        'ObligationActionResponse',
      ],
      ['/api/mobile/v1/needs-you/{id}/draft', 'postMobileNeedsYouDraft', null, 'ObligationDraftResponse'],
      [
        '/api/mobile/v1/needs-you/{id}/reply',
        'postMobileNeedsYouReply',
        'ObligationReplyRequest',
        'ObligationReplyResponse',
      ],
      [
        '/api/mobile/v1/needs-you/{id}/albatross',
        'postMobileNeedsYouAlbatross',
        null,
        'ObligationAlbatrossResponse',
      ],
    ];
    for (const [path, operationId, request, response] of operations) {
      const operation = document.paths[path].post;
      expect(operation.operationId).toBe(operationId);
      expect(operation.parameters[0]).toMatchObject({ name: 'id', in: 'path', required: true });
      expect(operation.responses['404']).toBeDefined();
      expect(operation.responses['200'].content['application/json'].schema.$ref).toBe(
        `#/components/schemas/${response}`,
      );
      if (request)
        expect(operation.requestBody.content['application/json'].schema.$ref).toBe(
          `#/components/schemas/${request}`,
        );
      else expect(operation.requestBody).toBeUndefined();
    }
    for (const name of ['NeedsYouSnapshot', 'ObligationView', 'ObligationAlbatrossResponse'])
      expect(document.components.schemas[name]).toBeDefined();
    // No nullable unions: the Swift generator drops them.
    expect(JSON.stringify(document.components.schemas.ObligationView)).not.toContain('"null"');
  });
});

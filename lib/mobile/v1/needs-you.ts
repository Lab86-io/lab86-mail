// Needs you for the native apps (docs/needs-you-phases-2-5.md, phase 5):
//   GET  /api/mobile/v1/needs-you                  NeedsYouSnapshot
//   POST /api/mobile/v1/needs-you/[id]             ObligationAction -> ObligationActionResponse
//   POST /api/mobile/v1/needs-you/[id]/draft       ObligationDraftResponse
//   POST /api/mobile/v1/needs-you/[id]/reply       { body } -> ObligationReplyResponse
//   POST /api/mobile/v1/needs-you/[id]/albatross   ObligationAlbatrossResponse
// The same services as the web routes (lib/obligations/service.ts,
// lib/obligations/albatross.ts), with the mobile auth, rate limits, and error
// envelope. The route files give the real dependencies.

import type { z } from 'zod';
import type { requireCurrentUser } from '@/lib/auth/current-user';
import {
  type ObligationAlbatrossDependencies,
  startObligationInAlbatross,
} from '@/lib/obligations/albatross';
import type { NeedsYouSnapshot } from '@/lib/obligations/contract';
import {
  ObligationApiError,
  type ObligationCaller,
  type ObligationServiceDependencies,
  prepareObligationDraft,
  runObligationAction,
  sendObligationReply,
} from '@/lib/obligations/service';
import type { enforceUserRateLimit } from '@/lib/rate-limit';
import {
  NeedsYouSnapshotSchema,
  ObligationActionResponseSchema,
  ObligationAlbatrossResponseSchema,
  ObligationDraftResponseSchema,
  ObligationReplyResponseSchema,
} from './contract';
import { mobileErrorResponse, mobileJSON, mobileRequestID } from './http';

export interface MobileNeedsYouDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  /** LAB86_NEEDS_YOU for the caller. */
  flag(userId: string): boolean;
  /** `api.obligationViews.snapshotFor`. */
  snapshot(userId: string): Promise<NeedsYouSnapshot>;
  service: ObligationServiceDependencies;
  albatross: ObligationAlbatrossDependencies;
}

export type MobileNeedsYouContext = { params: Promise<{ id: string }> };

const ERROR_CODES: Record<number, string> = {
  400: 'INVALID_REQUEST',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
};

/**
 * The mobile error envelope. A service error keeps its status (400, 403, 404,
 * 409, ...) and its message; every other error maps as in the other mobile
 * routes (401 without a session, 429 over the rate limit, 500).
 */
export function mobileObligationErrorResponse(error: unknown, requestID: string): Response {
  if (!(error instanceof ObligationApiError)) return mobileErrorResponse(error, requestID);
  const status = error.status;
  const code = ERROR_CODES[status] ?? (status >= 500 ? 'SERVER_ERROR' : 'INVALID_REQUEST');
  return mobileJSON(
    {
      ok: false,
      requestID,
      error: { code, message: error.message, retryable: status >= 500 || status === 429 },
    },
    { status },
    requestID,
  );
}

/**
 * The contract JSON of a response: keys outside the schema go, so a strict
 * decoder stays safe. A value that does not match keeps its keys and is
 * logged, so the app still gets its data.
 */
export function contractJSON(schema: z.ZodType, value: unknown, label: string): unknown {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  console.warn('[mobile needs-you] a response does not match the contract', {
    label,
    paths: parsed.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
  });
  return value;
}

async function callerFor(
  deps: MobileNeedsYouDependencies,
  key: string,
  limit: number,
): Promise<ObligationCaller> {
  const user = await deps.requireCurrentUser();
  await deps.enforceUserRateLimit({ userId: user.userId, key, limit, windowMs: 60_000 });
  return { userId: user.userId, email: user.email, name: user.name };
}

const DISABLED: NeedsYouSnapshot = { enabled: false, timezone: 'UTC', items: [] };

/** GET: the snapshot. A user outside the flag gets `enabled: false` and no items. */
export function createMobileNeedsYouGet(deps: MobileNeedsYouDependencies) {
  return async function mobileNeedsYouGet(request: Request) {
    const requestID = mobileRequestID(request);
    try {
      const caller = await callerFor(deps, 'needs-you-snapshot', 120);
      const snapshot = deps.flag(caller.userId) ? await deps.snapshot(caller.userId) : DISABLED;
      const payload = snapshot.enabled ? snapshot : { ...DISABLED, timezone: snapshot.timezone || 'UTC' };
      return mobileJSON(contractJSON(NeedsYouSnapshotSchema, payload, 'snapshot'), undefined, requestID);
    } catch (error) {
      return mobileObligationErrorResponse(error, requestID);
    }
  };
}

type PostRun = (caller: ObligationCaller, id: string, request: Request) => Promise<unknown>;

function post(
  deps: MobileNeedsYouDependencies,
  options: { key: string; limit: number; schema: z.ZodType; label: string },
  run: PostRun,
) {
  return async function mobileNeedsYouPost(request: Request, context: MobileNeedsYouContext) {
    const requestID = mobileRequestID(request);
    try {
      const caller = await callerFor(deps, options.key, options.limit);
      const { id } = await context.params;
      const result = await run(caller, id, request);
      return mobileJSON(contractJSON(options.schema, result, options.label), undefined, requestID);
    } catch (error) {
      return mobileObligationErrorResponse(error, requestID);
    }
  };
}

const jsonBody = (request: Request) => request.json().catch(() => null);

/** POST [id]: done, later with `until`, not_mine, undo, or rsvp with `response`. */
export function createMobileNeedsYouActionPost(deps: MobileNeedsYouDependencies) {
  return post(
    deps,
    { key: 'obligation-action', limit: 60, schema: ObligationActionResponseSchema, label: 'action' },
    async (caller, id, request) => runObligationAction(caller, id, await jsonBody(request), deps.service),
  );
}

/** POST [id]/draft: the prepared reply of a mail `reply` item. No body. */
export function createMobileNeedsYouDraftPost(deps: MobileNeedsYouDependencies) {
  return post(
    deps,
    { key: 'obligation-draft', limit: 20, schema: ObligationDraftResponseSchema, label: 'draft' },
    (caller, id) => prepareObligationDraft(caller, id, deps.service),
  );
}

/** POST [id]/reply with `{ body }`: sends the reply and closes the item as `sent_reply`. */
export function createMobileNeedsYouReplyPost(deps: MobileNeedsYouDependencies) {
  return post(
    deps,
    { key: 'obligation-reply', limit: 30, schema: ObligationReplyResponseSchema, label: 'reply' },
    async (caller, id, request) => sendObligationReply(caller, id, await jsonBody(request), deps.service),
  );
}

/** POST [id]/albatross: "Start in Albatross". No body. */
export function createMobileNeedsYouAlbatrossPost(deps: MobileNeedsYouDependencies) {
  return post(
    deps,
    {
      key: 'obligation-albatross',
      limit: 20,
      schema: ObligationAlbatrossResponseSchema,
      label: 'albatross',
    },
    (caller, id) => startObligationInAlbatross(caller, id, deps.albatross),
  );
}

// The server side of the Needs you API routes (phase 1 S7):
//   POST /api/obligations/[id]         an ObligationAction
//   POST /api/obligations/[id]/draft   a prepared reply
//   POST /api/obligations/[id]/reply   send the reply in the thread
// The route files authenticate and give the dependencies; this module holds
// the rules, so the tests run them without a network.

import { z } from 'zod';
import type { JevCorrection } from '../jev/contract';
import type {
  ObligationActionResponse,
  ObligationDraftResponse,
  ObligationReplyResponse,
  ObligationView,
} from './contract';

export class ObligationApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ObligationApiError';
  }
}

export interface ObligationCaller {
  userId: string;
  email?: string;
  name?: string;
}

/** What `api.obligations.get` gives for one row of the caller. */
export interface ObligationRecord {
  obligation: ObligationView;
  sourceMessageId: string | null;
  undo: { until: number; pendingId: string | null } | null;
  draft: ObligationDraftResponse['draft'] | null;
}

type ActResult =
  | { ok: true; obligation: ObligationView; undoUntil?: number }
  | { ok: false; error: string; pendingId?: string };

export interface ReplyTarget {
  accountId: string;
  threadId: string;
  messageId?: string;
}

export interface ObligationServiceDependencies {
  /** LAB86_NEEDS_YOU for the caller. */
  flag(userId: string): boolean;
  get(userId: string, id: string): Promise<ObligationRecord | null>;
  act(input: {
    userId: string;
    id: string;
    action: 'done' | 'later' | 'not_mine' | 'undo';
    until?: number;
    correction?: JevCorrection;
    sendCancelled?: boolean;
  }): Promise<ActResult>;
  recordReply(input: { userId: string; id: string; pendingId?: string; fireAt?: number }): Promise<ActResult>;
  saveDraft(input: { userId: string; id: string; draft: ObligationDraftResponse['draft'] }): Promise<unknown>;
  /** The scoped Jev correction of Not mine (lib/brief/steering.ts, "Not for me"). */
  correctionFor(target: ReplyTarget): JevCorrection;
  /** Cancels a reply that waits in the outbox. True when it did not go out. */
  cancelSend(userId: string, pendingId: string): Promise<boolean>;
  generateDraft(caller: ObligationCaller, target: ReplyTarget): Promise<ObligationDraftResponse['draft']>;
  /** Sends the reply through the compose path, with the user's undo-send delay. */
  sendReply(
    caller: ObligationCaller,
    target: ReplyTarget & { body: string },
  ): Promise<{ pendingId?: string; fireAt?: number }>;
}

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('done') }).strict(),
  z.object({ action: z.literal('later'), until: z.number().finite() }).strict(),
  z.object({ action: z.literal('not_mine') }).strict(),
  z.object({ action: z.literal('undo') }).strict(),
]);

const replySchema = z.object({ body: z.string().trim().min(1).max(20_000) }).strict();

const ACT_ERRORS: Record<string, [string, number]> = {
  not_found: ['Not found.', 404],
  closed: ['This item is already closed.', 409],
  invalid: ['Choose a time in the future, at most 90 days away.', 400],
  undo_expired: ['Undo is no longer available.', 409],
  send_pending: ['The reply is still waiting to send.', 409],
};

function failed(result: Extract<ActResult, { ok: false }>): never {
  const [message, status] = ACT_ERRORS[result.error] ?? ['The action did not complete.', 500];
  throw new ObligationApiError(message, status);
}

function isOpen(view: ObligationView) {
  return view.state === 'open' || view.state === 'snoozed';
}

/** The caller's row. Not in the flag, or another user's id: 404, so the two look the same. */
async function load(caller: ObligationCaller, id: string, deps: ObligationServiceDependencies) {
  if (!deps.flag(caller.userId)) throw new ObligationApiError('Not found.', 404);
  const record = await deps.get(caller.userId, id);
  if (!record) throw new ObligationApiError('Not found.', 404);
  return record;
}

function mailTarget(view: ObligationView): ReplyTarget {
  if (!view.accountId || !view.threadId || view.kind === 'code')
    throw new ObligationApiError('Only a mail conversation can have a reply.', 400);
  return {
    accountId: view.accountId,
    threadId: view.threadId,
    ...(view.messageId ? { messageId: view.messageId } : {}),
  };
}

export async function runObligationAction(
  caller: ObligationCaller,
  id: string,
  body: unknown,
  deps: ObligationServiceDependencies,
): Promise<ObligationActionResponse> {
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) throw new ObligationApiError('Send done, later with a time, not_mine, or undo.', 400);
  const action = parsed.data;
  const record = await load(caller, id, deps);
  const base = { userId: caller.userId, id };
  let result: ActResult;
  if (action.action === 'undo') {
    // An Undo after Send reply cancels the send first. A reply that already
    // left stays sent, and the item stays closed.
    const pendingId = record.undo?.pendingId;
    if (pendingId && !(await deps.cancelSend(caller.userId, pendingId)))
      throw new ObligationApiError('The reply already went out.', 409);
    result = await deps.act({ ...base, action: 'undo', ...(pendingId ? { sendCancelled: true } : {}) });
  } else if (action.action === 'not_mine') {
    const correction =
      record.obligation.kind === 'code' ? undefined : deps.correctionFor(mailTarget(record.obligation));
    result = await deps.act({ ...base, action: 'not_mine', ...(correction ? { correction } : {}) });
  } else if (action.action === 'later') {
    result = await deps.act({ ...base, action: 'later', until: action.until });
  } else {
    result = await deps.act({ ...base, action: 'done' });
  }
  if (!result.ok) failed(result);
  return { obligation: result.obligation, ...(result.undoUntil ? { undoUntil: result.undoUntil } : {}) };
}

export async function prepareObligationDraft(
  caller: ObligationCaller,
  id: string,
  deps: ObligationServiceDependencies,
): Promise<ObligationDraftResponse> {
  const record = await load(caller, id, deps);
  const target = mailTarget(record.obligation);
  if (record.obligation.kind !== 'reply')
    throw new ObligationApiError('Only a reply has a prepared draft.', 400);
  if (!isOpen(record.obligation)) throw new ObligationApiError('This item is already closed.', 409);
  if (record.draft) return { draft: record.draft };
  const draft = await deps.generateDraft(caller, target);
  // The draft is kept for the current source message. A failed save only
  // costs a second draft on the next open.
  await deps.saveDraft({ userId: caller.userId, id, draft }).catch(() => undefined);
  return { draft };
}

export async function sendObligationReply(
  caller: ObligationCaller,
  id: string,
  body: unknown,
  deps: ObligationServiceDependencies,
): Promise<ObligationReplyResponse> {
  const parsed = replySchema.safeParse(body);
  if (!parsed.success) throw new ObligationApiError('Write the reply first.', 400);
  const record = await load(caller, id, deps);
  const target = mailTarget(record.obligation);
  if (!isOpen(record.obligation)) throw new ObligationApiError('This item is already closed.', 409);
  const sent = await deps.sendReply(caller, { ...target, body: parsed.data.body });
  const result = await deps.recordReply({ userId: caller.userId, id, ...sent });
  if (!result.ok) failed(result);
  return { obligation: result.obligation, ...(result.undoUntil ? { undoUntil: result.undoUntil } : {}) };
}

import { NextRequest, NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { briefSteeringCorrection } from '@/lib/brief/steering';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { needsYouFlagFor } from '@/lib/obligations/contract';
import {
  ObligationApiError,
  type ObligationCaller,
  type ObligationRecord,
  type ObligationServiceDependencies,
  type ReplyTarget,
} from '@/lib/obligations/service';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { errorAnswerMessage } from '@/lib/security/error-answer';
import { replyTargetFor, resolveSendAnchor } from '@/lib/send/anchor';
import { cancelOutbox } from '@/lib/send/outbox';
import { draftReply } from '@/lib/tools/ai';
import { invokeTool } from '@/lib/tools/registry';
import { createComposePost } from '../compose/route';

// Shared parts of the Needs you routes (app/api/obligations/[id]/**). The
// rules are in lib/obligations/service.ts; this file gives the real
// dependencies and the error answers.

export interface ObligationRouteDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  service: ObligationServiceDependencies;
}

export type ObligationRouteContext = { params: Promise<{ id: string }> };

/** A prepared reply: the draft_reply text, addressed as the reply target of the evidence message. */
async function draftForObligation(caller: ObligationCaller, target: ReplyTarget) {
  const context = {
    userId: caller.userId,
    userEmail: caller.email,
    userName: caller.name,
    agent: 'user' as const,
  };
  return runWithAiRequestContext(context, async () => {
    const [anchor, result] = await Promise.all([
      resolveSendAnchor({
        account: target.accountId,
        messageId: target.messageId,
        threadId: target.threadId,
        userId: caller.userId,
      }),
      invokeTool(
        draftReply,
        { account: target.accountId, threadId: target.threadId },
        {
          ...context,
          account: target.accountId,
        },
      ) as Promise<{ draft?: string }>,
    ]);
    const reply = replyTargetFor(anchor);
    return { to: [reply.to], cc: [], subject: reply.subject, body: String(result?.draft || '') };
  });
}

/**
 * Sends the reply through the compose route, in the same request: the same
 * signature, From address, rate limit, audit row, and undo-send delay as a
 * reply from the composer.
 */
async function replyThroughCompose(_caller: ObligationCaller, target: ReplyTarget & { body: string }) {
  const pendingId = `outbox:${crypto.randomUUID()}`;
  const form = new FormData();
  form.set('mode', 'reply');
  form.set('account', target.accountId);
  form.set('threadId', target.threadId);
  if (target.messageId) form.set('messageId', target.messageId);
  form.set('body', target.body);
  form.set('pendingId', pendingId);
  const response = await createComposePost()(
    new NextRequest('http://localhost/api/compose', { method: 'POST', body: form }),
  );
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    pending?: { id?: string; fireAt?: number };
  };
  if (!response.ok || !payload.ok)
    throw new ObligationApiError(
      payload.error || 'The reply did not send.',
      response.status >= 400 ? response.status : 502,
    );
  return payload.pending?.fireAt
    ? { pendingId: payload.pending.id || pendingId, fireAt: payload.pending.fireAt }
    : {};
}

export const obligationServiceDefaults: ObligationServiceDependencies = {
  flag: (userId) => needsYouFlagFor(userId),
  get: (userId, id) => convexQuery<ObligationRecord | null>(api.obligations.get, { userId, id }),
  act: (input) => convexMutation(api.obligations.act, input),
  recordReply: (input) => convexMutation(api.obligations.recordReply, input),
  saveDraft: (input) => convexMutation(api.obligations.saveDraft, input),
  correctionFor: (target) =>
    briefSteeringCorrection(
      { mode: 'not_for_me', account: target.accountId, threadId: target.threadId },
      null,
    ),
  cancelSend: (userId, pendingId) => cancelOutbox(userId, pendingId),
  generateDraft: draftForObligation,
  sendReply: replyThroughCompose,
};

export const obligationRouteDefaults: ObligationRouteDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  service: obligationServiceDefaults,
};

/** 401 without a session, 429 over the rate limit, the service status, or a fixed 500 text. */
export function obligationErrorResponse(error: unknown, label: string) {
  if (error instanceof AuthRequiredError)
    return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
  if (error instanceof RateLimitError) return rateLimitJson(error);
  if (error instanceof ObligationApiError)
    return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
  return NextResponse.json(
    { ok: false, error: errorAnswerMessage(500, error, 'The request did not complete.', label) },
    { status: 500 },
  );
}

/** The caller, after the rate limit of the route. */
export async function obligationCaller(
  deps: ObligationRouteDependencies,
  key: string,
  limit: number,
): Promise<ObligationCaller> {
  const user = await deps.requireCurrentUser();
  await deps.enforceUserRateLimit({ userId: user.userId, key, limit, windowMs: 60_000 });
  return { userId: user.userId, email: user.email, name: user.name };
}

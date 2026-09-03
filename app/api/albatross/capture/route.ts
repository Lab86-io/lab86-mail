import type { NextRequest } from 'next/server';
import { captureFromChat } from '@/lib/albatross/capture-from-chat';
import { captureWork } from '@/lib/albatross/capture-work';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Capture Work. Two bodies:
// - `{ rawText, transcript?, source?, areaId?, reviewedItems? }`: the capture
//   sheet and voice capture.
// - `{ text, source: 'chat', conversationId, sourceMessageId?, replyText? }`:
//   the Ask / Hold bar and "Hold this" on a chat reply. `text` is the user
//   message and `replyText` the assistant reply. The capture stores both. A
//   second Hold on the same `(conversationId, sourceMessageId)` returns the
//   existing Work with `existing: true`.

interface CaptureRouteDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  captureWork: typeof captureWork;
  captureFromChat: typeof captureFromChat;
}

const defaultDependencies: CaptureRouteDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  captureWork,
  captureFromChat,
};

interface CaptureBody {
  rawText?: unknown;
  text?: unknown;
  transcript?: unknown;
  source?: unknown;
  timezone?: unknown;
  areaId?: unknown;
  reviewedItems?: unknown;
  conversationId?: unknown;
  sourceMessageId?: unknown;
  replyText?: unknown;
}

function json(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status });
}

function optionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function parseSource(value: unknown): 'text' | 'voice' | 'chat' {
  return value === 'voice' || value === 'chat' ? value : 'text';
}

/** A chat capture names the conversation. A `replyText` alone is not enough. */
export function isChatCaptureBody(body: CaptureBody): boolean {
  return (
    parseSource(body.source) === 'chat' &&
    typeof body.conversationId === 'string' &&
    body.conversationId.trim() !== ''
  );
}

export function createAlbatrossCapturePost(deps: CaptureRouteDependencies = defaultDependencies) {
  return async function albatrossCapturePost(req: NextRequest) {
    let body: CaptureBody;
    try {
      body = await req.json();
    } catch {
      return json(400, { ok: false, error: 'invalid json' });
    }
    const rawText = String(body.rawText ?? body.text ?? '').trim();
    if (!rawText) return json(400, { ok: false, error: 'rawText required' });
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'albatross-capture-v2',
        limit: 30,
        windowMs: 60_000,
      });
      if (isChatCaptureBody(body)) {
        const result = await deps.captureFromChat(
          {
            text: rawText,
            replyText: optionalString(body.replyText, 20_000),
            conversationId: optionalString(body.conversationId, 240),
            sourceMessageId: optionalString(body.sourceMessageId, 240),
          },
          user,
        );
        return json(200, { ok: true, status: 'split', ...result });
      }
      const reviewedItems = Array.isArray(body.reviewedItems)
        ? (body.reviewedItems as Array<{ title?: unknown; rawText?: unknown }>).map((item) => ({
            title: String(item?.title || ''),
            rawText: String(item?.rawText || ''),
          }))
        : undefined;
      const result = await deps.captureWork(
        {
          rawText,
          transcript: optionalString(body.transcript, 20_000),
          source: parseSource(body.source),
          areaId: optionalString(body.areaId, 240),
          reviewedItems,
        },
        user,
      );
      return json(200, { ok: true, ...result });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      if (error instanceof AuthRequiredError) return json(401, { ok: false, error: 'auth required' });
      return json(500, { ok: false, error: error instanceof Error ? error.message : 'capture failed' });
    }
  };
}

export const POST = createAlbatrossCapturePost();

import { type CaptureWorkInput, captureWork } from '@/lib/albatross/capture-work';
import type { WorkHorizon } from '@/lib/albatross/horizon';
import type { WorkShape } from '@/lib/albatross/work-shape';
import type { CurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';

// Capture Work from the chat bar or from a chat reply. The user text and the
// assistant reply are stored together as one raw capture, so the split reads
// both. A reply can be held once: the second Hold on the same reply returns
// the Work that already exists.

export interface ChatCaptureInput {
  /** The user's own words. Required. */
  text: string;
  /** The assistant reply the user chose to hold, when the Hold came from a reply. */
  replyText?: string;
  conversationId?: string;
  sourceMessageId?: string;
  /** An explicit shape from the caller. The split decides when absent. */
  shape?: WorkShape;
  /** An explicit horizon from the caller. Applied after capture. */
  horizon?: WorkHorizon;
}

export interface ChatCaptureWorkSummary {
  id: string;
  title: string;
  shape: string;
  horizon: WorkHorizon | null;
}

export interface ChatCaptureResult {
  captureId?: string;
  workIds: string[];
  work: ChatCaptureWorkSummary[];
  /** True when the reply was already held and no new Work was written. */
  existing: boolean;
  fallback?: boolean;
}

export interface ChatCaptureDependencies {
  captureWork: typeof captureWork;
  query: typeof convexQuery;
  mutate: typeof convexMutation;
}

const defaultDependencies: ChatCaptureDependencies = {
  captureWork,
  query: convexQuery,
  mutate: convexMutation,
};

export const CHAT_CAPTURE_TEXT_MAX = 20_000;

/** One id per held reply. Empty when the reply has no message id. */
export function chatCaptureExternalId(conversationId?: string, sourceMessageId?: string): string | null {
  const conversation = String(conversationId || '').trim();
  const message = String(sourceMessageId || '').trim();
  if (!conversation || !message) return null;
  return `chat:${conversation}:${message}`;
}

/** The raw capture text: the user message, then the reply. */
export function chatCaptureRawText(text: string, replyText?: string): string {
  const user = String(text || '').trim();
  const reply = String(replyText || '').trim();
  const joined = reply ? `${user}\n\n${reply}` : user;
  return joined.slice(0, CHAT_CAPTURE_TEXT_MAX);
}

function summaryFromRow(row: any): ChatCaptureWorkSummary {
  return {
    id: String(row?.id || ''),
    title: String(row?.title || 'Work'),
    shape: String(row?.shape || 'quick'),
    horizon: (row?.horizon as WorkHorizon | null | undefined) ?? null,
  };
}

export async function captureFromChat(
  input: ChatCaptureInput,
  user: CurrentUser,
  dependencies: ChatCaptureDependencies = defaultDependencies,
): Promise<ChatCaptureResult> {
  const rawText = chatCaptureRawText(input.text, input.replyText);
  if (!rawText) throw new Error('text required');
  const chatApi = (api as any).albatrossChatCapture;
  const externalId = chatCaptureExternalId(input.conversationId, input.sourceMessageId);

  if (externalId) {
    const held = await dependencies.query<any[]>(chatApi.findByExternalId, {
      userId: user.userId,
      externalId,
    });
    if (Array.isArray(held) && held.length) {
      const work = held.map(summaryFromRow);
      return {
        captureId: held.find((row) => row?.captureId)?.captureId,
        workIds: work.map((item) => item.id),
        work,
        existing: true,
      };
    }
  }

  // The split reads the text and picks a shape and a horizon. An explicit
  // `shape` or `horizon` from the caller is applied after, so it always wins.
  const captureInput: CaptureWorkInput = { rawText, source: 'chat' };
  const captured = await dependencies.captureWork(captureInput, user);

  if (externalId && captured.workIds.length) {
    await dependencies.mutate(chatApi.stampExternalId, {
      userId: user.userId,
      workIds: captured.workIds,
      externalId,
    });
  }
  for (const workId of captured.workIds) {
    if (input.shape) {
      await dependencies.mutate((api as any).albatrossWorkV2.setShape, {
        userId: user.userId,
        workId,
        shape: input.shape,
      });
    }
    if (input.horizon) {
      await dependencies.mutate((api as any).albatrossWorkV2.setHorizon, {
        userId: user.userId,
        workId,
        horizon: input.horizon,
      });
    }
  }

  const rows = await dependencies
    .query<any[]>(chatApi.summariesByIds, { userId: user.userId, workIds: captured.workIds })
    .catch(() => []);
  const byId = new Map((Array.isArray(rows) ? rows : []).map((row) => [String(row?.id), row]));
  const work = captured.workIds.map((workId) =>
    byId.has(workId)
      ? summaryFromRow(byId.get(workId))
      : { id: workId, title: 'Work', shape: input.shape || 'quick', horizon: input.horizon ?? null },
  );
  return {
    captureId: captured.captureId,
    workIds: captured.workIds,
    work,
    existing: false,
    fallback: captured.fallback,
  };
}

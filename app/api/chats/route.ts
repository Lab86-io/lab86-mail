import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { errorAnswerMessage } from '@/lib/security/error-answer';
import {
  type ChatSessionScope,
  deleteChatSession,
  getChatSession,
  getWorkThreadSession,
  listChatSessions,
  listScopedChatSessions,
  saveChatSession,
} from '@/lib/store/chat-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// AI chat history. All access runs inside the per-user request context, so
// sessions are tenant-scoped exactly like every other userDocs record.

async function withUser<T>(fn: () => Promise<T>) {
  const user = await requireCurrentUser();
  return await runWithAiRequestContext(
    { userId: user.userId, userEmail: user.email, userName: user.name, agent: 'user' },
    fn,
  );
}

function errorResponse(err: any) {
  if (err instanceof RateLimitError) return rateLimitJson(err);
  const status = err instanceof AuthRequiredError ? 401 : 500;
  return NextResponse.json(
    { ok: false, error: errorAnswerMessage(status, err, 'chat history failed', '[chats] request failed') },
    { status },
  );
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  const workThread = (req.nextUrl.searchParams.get('workThread') || '').trim().slice(0, 64);
  try {
    return await withUser(async () => {
      // The conversation of one Work (docs/albatross-thread.md).
      if (workThread) {
        const session = await getWorkThreadSession(workThread);
        return NextResponse.json({ ok: true, session });
      }
      if (id) {
        const session = await getChatSession(id);
        return NextResponse.json({ ok: true, session });
      }
      const kind = req.nextUrl.searchParams.get('scopeKind');
      const scope =
        kind === 'global' || kind === 'area' || kind === 'work'
          ? ({
              kind,
              areaId: req.nextUrl.searchParams.get('areaId') || undefined,
              workId: req.nextUrl.searchParams.get('workId') || undefined,
            } satisfies ChatSessionScope)
          : null;
      const sessions = scope ? await listScopedChatSessions(scope) : await listChatSessions();
      return NextResponse.json({ ok: true, sessions });
    });
  } catch (err: any) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  let body: {
    id?: string;
    title?: string;
    messages?: unknown[];
    scope?: ChatSessionScope;
    scopeKind?: string;
    areaId?: string;
    workId?: string;
    /** Work threads: the updatedAt of the copy the client loaded, so the save merges. */
    baseUpdatedAt?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const id = String(body.id || '').trim();
  if (!id || !/^[a-zA-Z0-9_-]{8,64}$/.test(id)) {
    return NextResponse.json({ ok: false, error: 'valid session id required' }, { status: 400 });
  }
  if (!Array.isArray(body.messages)) {
    return NextResponse.json({ ok: false, error: 'messages required' }, { status: 400 });
  }
  const kind = body.scope?.kind || body.scopeKind || 'global';
  if (!['global', 'area', 'work'].includes(kind)) {
    return NextResponse.json({ ok: false, error: 'invalid chat scope' }, { status: 400 });
  }
  const areaId =
    String(body.scope?.areaId || body.areaId || '')
      .trim()
      .slice(0, 180) || undefined;
  const workId =
    String(body.scope?.workId || body.workId || '')
      .trim()
      .slice(0, 180) || undefined;
  if (kind === 'area' && !areaId) {
    return NextResponse.json({ ok: false, error: 'areaId required for Area chat' }, { status: 400 });
  }
  if (kind === 'work' && !workId) {
    return NextResponse.json({ ok: false, error: 'workId required for Work chat' }, { status: 400 });
  }
  const scope: ChatSessionScope = { kind: kind as ChatSessionScope['kind'], areaId, workId };
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({ userId: user.userId, key: 'chat-save', limit: 120, windowMs: 60_000 });
    const session = await runWithAiRequestContext(
      { userId: user.userId, userEmail: user.email, userName: user.name, agent: 'user' },
      () =>
        saveChatSession(id, body.messages as any[], body.title, scope, {
          baseUpdatedAt:
            typeof body.baseUpdatedAt === 'number' && Number.isFinite(body.baseUpdatedAt)
              ? body.baseUpdatedAt
              : undefined,
        }),
    );
    const { messages: _messages, mergedMessages, ...summary } = session;
    // A Work thread save that kept another device's messages returns them, so
    // the client adds them (docs/albatross-thread.md, "The timeline").
    return NextResponse.json({ ok: true, session: summary, ...(mergedMessages ? { mergedMessages } : {}) });
  } catch (err: any) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  try {
    return await withUser(async () => {
      await deleteChatSession(id);
      return NextResponse.json({ ok: true });
    });
  } catch (err: any) {
    return errorResponse(err);
  }
}

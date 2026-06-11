import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import {
  deleteChatSession,
  getChatSession,
  listChatSessions,
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
  return NextResponse.json({ ok: false, error: err?.message || 'chat history failed' }, { status });
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  try {
    return await withUser(async () => {
      if (id) {
        const session = await getChatSession(id);
        return NextResponse.json({ ok: true, session });
      }
      const sessions = await listChatSessions();
      return NextResponse.json({ ok: true, sessions });
    });
  } catch (err: any) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  let body: { id?: string; title?: string; messages?: unknown[] };
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
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({ userId: user.userId, key: 'chat-save', limit: 120, windowMs: 60_000 });
    const session = await runWithAiRequestContext(
      { userId: user.userId, userEmail: user.email, userName: user.name, agent: 'user' },
      () => saveChatSession(id, body.messages as any[], body.title),
    );
    const { messages: _messages, ...summary } = session;
    return NextResponse.json({ ok: true, session: summary });
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

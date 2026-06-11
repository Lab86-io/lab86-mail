import { convertToModelMessages, type UIMessage } from 'ai';
import type { NextRequest } from 'next/server';
import { runAgent } from '@/lib/ai/loop';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

interface AgentRequestBody {
  messages: UIMessage[];
  extraSystem?: string;
}

export async function POST(req: NextRequest) {
  let body: AgentRequestBody;
  try {
    body = (await req.json()) as AgentRequestBody;
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid json' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (!Array.isArray(body.messages)) {
    return new Response(JSON.stringify({ ok: false, error: 'messages required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'agent',
      limit: 60,
      windowMs: 60_000,
    });
    const modelMessages = await convertToModelMessages(body.messages);
    const stream = await runAgent({
      messages: modelMessages,
      extraSystem: body.extraSystem,
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
    });
    return stream.toUIMessageStreamResponse();
  } catch (err: any) {
    if (err instanceof RateLimitError) return rateLimitResponse(err);
    const status = err instanceof AuthRequiredError ? 401 : 500;
    return new Response(JSON.stringify({ ok: false, error: err?.message || 'agent failed' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
}

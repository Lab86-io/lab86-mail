import { convertToModelMessages, type UIMessage } from 'ai';
import type { NextRequest } from 'next/server';
import { runAgent } from '@/lib/ai/loop';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';

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
    const modelMessages = await convertToModelMessages(body.messages);
    const stream = await runAgent({
      messages: modelMessages,
      extraSystem: body.extraSystem,
      userId: user.userId,
      userEmail: user.email,
    });
    return stream.toUIMessageStreamResponse();
  } catch (err: any) {
    const status = err instanceof AuthRequiredError ? 401 : 500;
    return new Response(JSON.stringify({ ok: false, error: err?.message || 'agent failed' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
}

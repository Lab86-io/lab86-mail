import type { NextRequest } from 'next/server';
import { convertToModelMessages, type UIMessage } from 'ai';
import { runAgent } from '@/lib/ai/loop';

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
    const modelMessages = await convertToModelMessages(body.messages);
    const stream = runAgent({
      messages: modelMessages,
      extraSystem: body.extraSystem,
    });
    return stream.toUIMessageStreamResponse();
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err?.message || 'agent failed' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}

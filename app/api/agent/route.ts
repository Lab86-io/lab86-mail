import { convertToModelMessages, type UIMessage } from 'ai';
import type { NextRequest } from 'next/server';
import { runAgent } from '@/lib/ai/loop';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_AGENT_MESSAGES = 72;
const FULL_RECENT_MESSAGES = 28;
const MAX_MODEL_MESSAGE_BYTES = 180_000;
const MAX_COMPACT_TEXT_CHARS = 12_000;

interface AgentRequestBody {
  messages: UIMessage[];
  extraSystem?: string;
  timezone?: string;
}

function messageText(message: UIMessage): string {
  const raw = message as any;
  if (typeof raw.content === 'string') return raw.content;
  if (!Array.isArray(raw.parts)) return '';
  return raw.parts
    .map((part: any) => {
      if (typeof part?.text === 'string') return part.text;
      if (part?.type === 'reasoning' && typeof part.reasoning === 'string') return part.reasoning;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function compactOldMessage(message: UIMessage): UIMessage {
  const raw = message as any;
  const text = messageText(message).trim();
  const compactText = text
    ? text.slice(0, MAX_COMPACT_TEXT_CHARS)
    : `[Earlier ${raw.role || 'conversation'} message omitted because it contained only tool/UI payloads.]`;
  return {
    ...raw,
    parts: [{ type: 'text', text: compactText }],
  } as UIMessage;
}

function prepareAgentMessages(input: UIMessage[]): {
  messages: UIMessage[];
  omitted: number;
  compacted: number;
} {
  let omitted = Math.max(0, input.length - MAX_AGENT_MESSAGES);
  let compacted = 0;
  const kept = input.slice(-MAX_AGENT_MESSAGES);
  let prepared = kept.map((message, index) => {
    const shouldCompact = index < kept.length - FULL_RECENT_MESSAGES;
    if (!shouldCompact) return message;
    compacted += 1;
    return compactOldMessage(message);
  });

  while (
    JSON.stringify(prepared).length > MAX_MODEL_MESSAGE_BYTES &&
    prepared.length > FULL_RECENT_MESSAGES
  ) {
    prepared = prepared.slice(1);
    omitted += 1;
  }

  return { messages: prepared, omitted, compacted };
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
    const prepared = prepareAgentMessages(body.messages);
    const compactionNote =
      prepared.omitted || prepared.compacted
        ? `Conversation continuity note: ${prepared.omitted} older UI message(s) were omitted and ${prepared.compacted} older message(s) were compacted to text-only form to keep this long conversation stable. Treat the remaining recent transcript as authoritative.`
        : '';
    const modelMessages = await convertToModelMessages(prepared.messages);
    const stream = await runAgent({
      messages: modelMessages,
      extraSystem: [body.extraSystem, compactionNote].filter(Boolean).join('\n\n') || undefined,
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      userTimezone: typeof body.timezone === 'string' ? body.timezone : undefined,
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

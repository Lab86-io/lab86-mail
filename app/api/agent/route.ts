import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from 'ai';
import { after, type NextRequest } from 'next/server';
import { runAgent } from '@/lib/ai/loop';
import { sanitizeToolPairs } from '@/lib/ai/message-sanitize';
import { readAreaDiscoveryContext } from '@/lib/albatross/area-discovery';
import { readWorkChatContext, WorkContextNotFoundError } from '@/lib/albatross/work-chat-context';
import { reconcileWorkTurn } from '@/lib/albatross/work-turn-reconcile';
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
  areaDiscovery?: { mode: 'teach' | 'area'; areaId?: string };
  contextAttachments?: Array<{ kind: 'work'; id: string }>;
}

export class InvalidContextAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidContextAttachmentError';
  }
}

export function normalizeContextAttachments(value: unknown): Array<{ kind: 'work'; id: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new InvalidContextAttachmentError('contextAttachments must be an array.');
  if (value.length > 3) throw new InvalidContextAttachmentError('At most 3 context attachments are allowed.');
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object')
      throw new InvalidContextAttachmentError('Invalid context attachment.');
    const kind = (entry as any).kind;
    const id = typeof (entry as any).id === 'string' ? (entry as any).id.trim() : '';
    if (kind !== 'work' || !id || id.length > 180) {
      throw new InvalidContextAttachmentError('Invalid Work context attachment.');
    }
    const key = `${kind}:${id}`;
    if (seen.has(key)) throw new InvalidContextAttachmentError('Duplicate context attachment.');
    seen.add(key);
    return { kind, id };
  });
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

function errorForLog(err: any) {
  return {
    name: err?.name,
    message: err?.message,
    statusCode: err?.statusCode,
    isRetryable: err?.isRetryable,
    responseBody: typeof err?.responseBody === 'string' ? err.responseBody.slice(0, 500) : undefined,
  };
}

function agentErrorStreamResponse(message: string) {
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: 'start' });
        writer.write({ type: 'error', errorText: message });
        writer.write({ type: 'finish', finishReason: 'error' });
      },
    }),
  });
}

export async function POST(req: NextRequest) {
  let body: AgentRequestBody;
  try {
    body = (await req.json()) as AgentRequestBody;
  } catch (err: any) {
    console.warn('[agent-route] invalid request json', {
      message: err?.message,
      contentType: req.headers.get('content-type'),
      contentLength: req.headers.get('content-length'),
    });
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
    const areaDiscoveryContext = body.areaDiscovery
      ? await readAreaDiscoveryContext({
          userId: user.userId,
          areaId: body.areaDiscovery.mode === 'area' ? body.areaDiscovery.areaId : undefined,
        })
          .then((result) => result.systemContext)
          .catch((error) => {
            console.warn('[agent-route] area discovery context failed', errorForLog(error));
            return '';
          })
      : '';
    const contextAttachments = normalizeContextAttachments(body.contextAttachments);
    const attachedContexts = await Promise.all(
      contextAttachments.map((attachment) =>
        readWorkChatContext({ userId: user.userId, workId: attachment.id }).then(
          (result) => result.systemContext,
        ),
      ),
    );
    const modelMessages = sanitizeToolPairs(await convertToModelMessages(prepared.messages));
    const stream = await runAgent({
      messages: modelMessages,
      extraSystem:
        [body.extraSystem, areaDiscoveryContext, ...attachedContexts, compactionNote]
          .filter(Boolean)
          .join('\n\n') || undefined,
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      userTimezone: typeof body.timezone === 'string' ? body.timezone : undefined,
    });
    // The loop that always closes: after every Work-scoped turn, the server
    // reconciles the turn back into the Work document — chat-created artifacts,
    // answered questions, and a replan — independent of what the model chose
    // to call. Runs after the response so the chat never waits on it.
    // Only an unambiguous turn reconciles: with several Works attached, the
    // turn's artifacts and answers cannot be attributed to one of them, and
    // fanning out would cross-pollinate evidence between Works.
    const workAttachments = contextAttachments.filter((attachment) => attachment.kind === 'work');
    if (workAttachments.length === 1) {
      const workId = workAttachments[0].id;
      after(() =>
        reconcileWorkTurn({
          userId: user.userId,
          userEmail: user.email,
          userName: user.name,
          workId,
          timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
          steps: Array.isArray(stream.result?.steps) ? stream.result.steps : [],
          uiMessages: prepared.messages,
        }).then(() => undefined),
      );
    }
    return stream.toUIMessageStreamResponse();
  } catch (err: any) {
    if (err instanceof RateLimitError) return rateLimitResponse(err);
    const status =
      err instanceof AuthRequiredError
        ? 401
        : err instanceof InvalidContextAttachmentError
          ? 400
          : err instanceof WorkContextNotFoundError
            ? 404
            : 500;
    console.error('[agent-route]', errorForLog(err));
    if (status === 500) {
      return agentErrorStreamResponse(err?.message || 'agent failed');
    }
    return new Response(JSON.stringify({ ok: false, error: err?.message || 'agent failed' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
}

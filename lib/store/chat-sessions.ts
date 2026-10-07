import { isHitlToolName, toolPartName } from '../albatross/teach-ui';
import { isWorkThreadSessionId, workThreadSessionId } from '../albatross/thread-contract';
import { kvDelete, kvGet, kvList, kvUpsert } from './kv';

// Persistent AI chat sessions. Each session stores the AI SDK UIMessage array
// (with oversized tool payloads stripped) in the per-user userDocs store, so
// conversations survive reloads and are listable as history.

export interface ChatSessionSummary {
  _id: string;
  title: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  scope?: ChatSessionScope;
}

export interface ChatSession extends ChatSessionSummary {
  messages: unknown[];
  /**
   * Work threads only, on a save: the stored messages that the save did not
   * hold and the merge kept (another device wrote them). The client adds them
   * to its own list, so its next save does not count them as removed.
   */
  mergedMessages?: unknown[];
}

export interface ChatSessionScope {
  kind: 'global' | 'area' | 'work';
  areaId?: string;
  workId?: string;
}

const KIND = 'chatSession';
const MAX_MESSAGES = 80;
const MAX_PART_JSON_BYTES = 4_000;
// Choice receipts are bounded by their schema and must survive reload, including
// the complete 30-slide selection and free-form source guidance.
const MAX_PRESENTATION_CHOICES_BYTES = 32_000;
// A researched plan/partial recovery must survive the next picker round trip.
const MAX_PRESENTATION_PLAN_BYTES = 128_000;
const MAX_SESSIONS_LISTED = 30;
/** Tools whose output never goes into saved history. */
const PRIVATE_OUTPUT_TOOLS: ReadonlySet<string> = new Set(['personal_details_get']);
const MAX_SESSIONS_SCANNED = 1_000;

// Keep confirmed results and uncertainty distinct when restoring interrupted chat.
// HITL questions retain their pending state; an interrupted server call is not a success.
export function compactMessage(message: any): any {
  const parts = Array.isArray(message?.parts)
    ? message.parts.map((part: any) => {
        const type = String(part?.type || '');
        if (type !== 'dynamic-tool' && !type.startsWith('tool-')) return part;
        const isHitlPause = part.state === 'input-available' && isHitlToolName(toolPartName(part));
        const interrupted = ['input-available', 'input-streaming'].includes(part.state) && !isHitlPause;
        const compact: Record<string, unknown> = {
          type: part.type,
          toolName: part.toolName,
          toolCallId: part.toolCallId,
          state: interrupted ? 'output-error' : part.state,
          errorText: interrupted
            ? 'Interrupted: outcome not confirmed. Continue checks saved work before retrying.'
            : part.errorText,
          input: part.input,
        };
        // Personal details stay in their encrypted store, not in saved chats.
        if (PRIVATE_OUTPUT_TOOLS.has(toolPartName(part))) {
          if (part.state === 'output-available')
            compact.output = {
              outputOmitted: true,
              message:
                'Personal details were read. Read them again with personal_details_get when a form needs them.',
            };
          return compact;
        }
        try {
          const limit =
            toolPartName(part) === 'ask_presentation_choices'
              ? MAX_PRESENTATION_CHOICES_BYTES
              : toolPartName(part) === 'presentation_plan'
                ? MAX_PRESENTATION_PLAN_BYTES
                : MAX_PART_JSON_BYTES;
          const serialized = part.output === undefined ? undefined : JSON.stringify(part.output);
          // Measure the new plan budget in actual storage bytes. Keep existing
          // receipt/text limits unchanged so older Unicode answers still restore.
          if (
            serialized !== undefined &&
            (toolPartName(part) === 'presentation_plan'
              ? new TextEncoder().encode(serialized).length
              : serialized.length) <= limit
          ) {
            compact.output = part.output;
          } else if (part.state === 'output-available') {
            compact.output =
              toolPartName(part) === 'presentation_plan'
                ? {
                    ok: false,
                    readyToBuild: false,
                    outputOmitted: true,
                    nextStep:
                      'The detailed plan exceeded saved-history capacity. Retain the evidence in this tool input and all confirmed presentation choices. Reconstruct the per-slide plan from that evidence before asking for storyboard confirmation; no deck was created by this planning call.',
                  }
                : {
                    outputOmitted: true,
                    message: ['document_get', 'word_document_get', 'google_document_get'].includes(
                      toolPartName(part),
                    )
                      ? 'Read succeeded. Reread the source for its full contents before editing.'
                      : 'Tool completed successfully. Its full output was omitted from saved history; read the source again if needed.',
                  };
          }
        } catch {
          // unserializable output — drop it
        }
        return compact;
      })
    : message?.parts;
  return { ...message, parts };
}

export function chatTitleFromMessages(messages: any[]): string {
  for (const message of messages) {
    if (message?.role !== 'user') continue;
    const text =
      typeof message.content === 'string'
        ? message.content
        : (message.parts || [])
            .filter((part: any) => part?.type === 'text')
            .map((part: any) => part.text || '')
            .join(' ');
    const trimmed = String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (trimmed) return trimmed.slice(0, 64);
  }
  return 'New chat';
}

function messageCreatedAt(message: any): number | null {
  const at = message?.metadata?.createdAt;
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

/**
 * Merge a save of a Work thread with the stored copy, so two devices do not
 * delete each other's messages (docs/albatross-thread.md, "The timeline").
 * The saved list wins for every id it holds. A stored message that the save
 * does not hold stays only when it is newer than the copy the client loaded
 * (`baseUpdatedAt`): another device wrote it. An older one was removed on
 * purpose (a retry or an edit), so it goes.
 */
export function mergeThreadMessages(
  stored: readonly any[],
  incoming: readonly any[],
  baseUpdatedAt: number,
): any[] {
  const incomingIds = new Set(incoming.map((message) => String(message?.id || '')).filter(Boolean));
  const extra = stored.filter((message) => {
    const id = String(message?.id || '');
    if (!id || incomingIds.has(id)) return false;
    const at = messageCreatedAt(message);
    return at !== null && at > baseUpdatedAt;
  });
  if (!extra.length) return [...incoming];
  // A message without a time takes the time of the message before it, so the
  // sort keeps it in place; the source order breaks ties.
  const stamp = (list: readonly any[], source: number) => {
    let last = 0;
    return list.map((message, index) => {
      const at = messageCreatedAt(message);
      if (at !== null) last = at;
      return { message, at: at ?? last, source, index };
    });
  };
  return [...stamp(incoming, 0), ...stamp(extra, 1)]
    .sort((a, b) => a.at - b.at || a.source - b.source || a.index - b.index)
    .map((entry) => entry.message);
}

export async function saveChatSession(
  id: string,
  messages: any[],
  title?: string,
  scope?: ChatSessionScope,
  options: { baseUpdatedAt?: number } = {},
): Promise<ChatSession> {
  const existing = await kvGet<ChatSession>(KIND, id).catch(() => null);
  const now = Date.now();
  const merged =
    existing && isWorkThreadSessionId(id) && typeof options.baseUpdatedAt === 'number'
      ? mergeThreadMessages(existing.messages || [], messages, options.baseUpdatedAt)
      : messages;
  const incomingIds = new Set(messages.map((message) => String(message?.id || '')));
  const mergedMessages = merged.filter((message) => !incomingIds.has(String(message?.id || '')));
  const session: ChatSession = {
    _id: id,
    title: title || existing?.title || chatTitleFromMessages(merged),
    messages: merged.slice(-MAX_MESSAGES).map(compactMessage),
    messageCount: merged.length,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    scope: scope || existing?.scope,
  };
  await kvUpsert(KIND, id, session);
  return mergedMessages.length ? { ...session, mergedMessages } : session;
}

export async function getChatSession(id: string): Promise<ChatSession | null> {
  return await kvGet<ChatSession>(KIND, id);
}

export async function listChatSessions(limit = MAX_SESSIONS_LISTED): Promise<ChatSessionSummary[]> {
  const rows = await kvList<ChatSession>(KIND, { limit });
  return rows
    .map(({ messages: _messages, ...summary }) => summary)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

export function filterChatSessionsByScope(
  rows: ChatSessionSummary[],
  scope: ChatSessionScope,
  limit = MAX_SESSIONS_LISTED,
) {
  return rows
    .filter((row) => {
      const rowScope = row.scope || { kind: 'global' as const };
      if (rowScope.kind !== scope.kind) return false;
      if (scope.areaId && rowScope.areaId !== scope.areaId) return false;
      if (scope.workId && rowScope.workId !== scope.workId) return false;
      return true;
    })
    .slice(0, limit);
}

export async function listScopedChatSessions(scope: ChatSessionScope, limit = MAX_SESSIONS_LISTED) {
  // Scope before applying the display cap. Otherwise 30 newer global chats
  // can hide every matching Area or Work conversation.
  const rows = await kvList<ChatSession>(KIND, { limit: MAX_SESSIONS_SCANNED });
  const summaries = rows
    .map(({ messages: _messages, ...summary }) => summary)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  return filterChatSessionsByScope(summaries, scope, limit);
}

export async function deleteChatSession(id: string) {
  await kvDelete(KIND, id);
}

/**
 * The conversation of a Work (docs/albatross-thread.md): its canonical
 * session `work-<workId>`. When it does not exist yet, the newest older chat
 * about this Work moves to the canonical id, so the talk before the thread
 * existed stays in the thread. Returns null for a Work with no chat.
 */
export async function getWorkThreadSession(workId: string): Promise<ChatSession | null> {
  const id = workThreadSessionId(workId);
  const canonical = await kvGet<ChatSession>(KIND, id);
  if (canonical) return canonical;
  const [newest] = (await listScopedChatSessions({ kind: 'work', workId }, 1)).filter(
    (row) => row._id !== id,
  );
  if (!newest) return null;
  const legacy = await kvGet<ChatSession>(KIND, newest._id);
  if (!legacy) return null;
  const moved: ChatSession = { ...legacy, _id: id, scope: { kind: 'work', workId } };
  await kvUpsert(KIND, id, moved);
  await kvDelete(KIND, newest._id);
  return moved;
}

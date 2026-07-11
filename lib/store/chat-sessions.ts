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
}

export interface ChatSessionScope {
  kind: 'global' | 'area' | 'work';
  areaId?: string;
  workId?: string;
}

const KIND = 'chatSession';
const MAX_MESSAGES = 80;
const MAX_PART_JSON_BYTES = 4_000;
const MAX_SESSIONS_LISTED = 30;

// Tool outputs can carry whole thread bodies; history only needs the shape
// (name, state, input) for the step cards, so big payloads are dropped.
function compactMessage(message: any): any {
  const parts = Array.isArray(message?.parts)
    ? message.parts.map((part: any) => {
        const type = String(part?.type || '');
        if (type !== 'dynamic-tool' && !type.startsWith('tool-')) return part;
        const compact: Record<string, unknown> = {
          type: part.type,
          toolName: part.toolName,
          toolCallId: part.toolCallId,
          state: part.state === 'input-available' ? 'output-available' : part.state,
          input: part.input,
        };
        try {
          if (part.output !== undefined && JSON.stringify(part.output).length <= MAX_PART_JSON_BYTES) {
            compact.output = part.output;
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

export async function saveChatSession(
  id: string,
  messages: any[],
  title?: string,
  scope?: ChatSessionScope,
): Promise<ChatSession> {
  const existing = await kvGet<ChatSession>(KIND, id).catch(() => null);
  const now = Date.now();
  const session: ChatSession = {
    _id: id,
    title: title || existing?.title || chatTitleFromMessages(messages),
    messages: messages.slice(-MAX_MESSAGES).map(compactMessage),
    messageCount: messages.length,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    scope: scope || existing?.scope,
  };
  await kvUpsert(KIND, id, session);
  return session;
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

export async function listScopedChatSessions(scope: ChatSessionScope, limit = MAX_SESSIONS_LISTED) {
  const rows = await listChatSessions(MAX_SESSIONS_LISTED);
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

export async function deleteChatSession(id: string) {
  await kvDelete(KIND, id);
}

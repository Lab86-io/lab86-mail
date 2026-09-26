import { randomUUID } from 'node:crypto';
import { kvDelete, kvGet, kvList, kvUpsert } from '../store/kv';

// Saved replies (FEATURES item 11): named snippets the user writes once and
// inserts in the composer. The assistant reads them through
// list_saved_replies, so a draft can use the user's own wording.

export const SAVED_REPLY_KIND = 'savedReply';
export const SAVED_REPLY_NAME_MAX = 80;
export const SAVED_REPLY_BODY_MAX = 5_000;
export const SAVED_REPLY_LIMIT = 100;

export interface SavedReply {
  id: string;
  name: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export async function listSavedReplies(): Promise<SavedReply[]> {
  const rows = await kvList<SavedReply>(SAVED_REPLY_KIND, { limit: SAVED_REPLY_LIMIT });
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

export async function getSavedReply(id: string): Promise<SavedReply | null> {
  return await kvGet<SavedReply>(SAVED_REPLY_KIND, id);
}

/** Creates a saved reply, or updates the one with `id`. Names are unique. */
export async function saveSavedReply(input: {
  id?: string;
  name: string;
  body: string;
}): Promise<SavedReply> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  const body = input.body.replace(/\r\n/g, '\n').trim();
  if (!name) throw new Error('Give the saved reply a name.');
  if (name.length > SAVED_REPLY_NAME_MAX)
    throw new Error(`A name can be at most ${SAVED_REPLY_NAME_MAX} characters.`);
  if (!body) throw new Error('Write the text of the saved reply.');
  if (body.length > SAVED_REPLY_BODY_MAX)
    throw new Error(`A saved reply can be at most ${SAVED_REPLY_BODY_MAX} characters.`);
  const existing = await listSavedReplies();
  const clash = existing.find(
    (reply) => reply.id !== input.id && reply.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) throw new Error(`A saved reply named "${clash.name}" already exists.`);
  const previous = input.id ? existing.find((reply) => reply.id === input.id) : undefined;
  if (input.id && !previous) throw new Error('Saved reply not found.');
  if (!previous && existing.length >= SAVED_REPLY_LIMIT)
    throw new Error(`You can keep up to ${SAVED_REPLY_LIMIT} saved replies.`);
  const now = Date.now();
  const reply: SavedReply = {
    id: previous?.id ?? randomUUID(),
    name,
    body,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  await kvUpsert(SAVED_REPLY_KIND, reply.id, reply);
  return reply;
}

export async function deleteSavedReply(id: string): Promise<boolean> {
  const existing = await getSavedReply(id);
  if (!existing) return false;
  await kvDelete(SAVED_REPLY_KIND, id);
  return true;
}

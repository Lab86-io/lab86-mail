import type { Message } from '../shared/types';
import { kvGet, kvList, kvUpsert } from './kv';

// Cache payload caps keep userDocs rows well under Convex's 1MB document
// limit even for image-heavy newsletters.
const HTML_BODY_CAP = 200_000;
const TEXT_BODY_CAP = 64_000;

export async function upsertMessage(message: Message) {
  message.cachedAt = Date.now();
  const doc: Message = {
    ...message,
    textBody: (message.textBody || '').slice(0, TEXT_BODY_CAP),
    htmlBody: (message.htmlBody || '').slice(0, HTML_BODY_CAP),
  };
  await kvUpsert('msgCache', `${doc.account}:${doc._id}`, doc, `${doc.account}:${doc.threadId}`);
}

export async function getMessage(account: string, id: string): Promise<Message | null> {
  return await kvGet<Message>('msgCache', `${account}:${id}`);
}

export async function getThreadMessages(account: string, threadId: string): Promise<Message[]> {
  const rows = await kvList<Message>('msgCache', { ref: `${account}:${threadId}`, limit: 500 });
  rows.sort((a, b) => (a.date || 0) - (b.date || 0));
  return rows;
}

import type { Message } from '../shared/types';
import { kvGet, kvList, kvUpsert } from './kv';

// Cache payload caps keep userDocs rows well under Convex's 1MB document
// limit even for image-heavy newsletters.
const HTML_BODY_CAP = 200_000;
const TEXT_BODY_CAP = 64_000;

export async function upsertMessage(message: Message) {
  message.cachedAt = Date.now();
  const textBody = message.textBody || '';
  const htmlBody = message.htmlBody || '';
  const truncatedFields = [
    textBody.length > TEXT_BODY_CAP ? 'textBody' : '',
    htmlBody.length > HTML_BODY_CAP ? 'htmlBody' : '',
  ].filter(Boolean);
  const doc: Message & { truncatedFields?: string[] } = {
    ...message,
    textBody: textBody.slice(0, TEXT_BODY_CAP),
    htmlBody: htmlBody.slice(0, HTML_BODY_CAP),
    truncatedFields: truncatedFields.length ? truncatedFields : undefined,
  };
  if (truncatedFields.length) {
    console.warn(`[msgCache] truncated ${doc.account}:${doc._id} fields=${truncatedFields.join(',')}`);
  }
  await kvUpsert('msgCache', `${doc.account}:${doc._id}`, doc, `${doc.account}:${doc.threadId}`);
}

export async function getMessage(account: string, id: string): Promise<Message | null> {
  return await kvGet<Message>('msgCache', `${account}:${id}`);
}

export async function getThreadMessages(account: string, threadId: string): Promise<Message[]> {
  const rows = await kvList<Message>('msgCache', { ref: `${account}:${threadId}` });
  rows.sort((a, b) => (a.date || 0) - (b.date || 0));
  return rows;
}

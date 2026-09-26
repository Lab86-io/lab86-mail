import { api, convexQuery } from '../hosted/convex';
import { isConvexConfigured } from '../hosted/env';
import { getNylasMessage, getNylasThread } from '../nylas/provider';
import type { Message } from '../shared/types';
import { kvGet, kvList, kvUpsert, requireStoreUserId } from './kv';

// Cache payload caps keep userDocs rows well under Convex's 1MB document
// limit even for image-heavy newsletters.
const HTML_BODY_CAP = 200_000;
const TEXT_BODY_CAP = 64_000;

const corpusApi = (api as any).mailCorpus;

// The hosted source of truth for mail is the Convex corpus, which webhook and
// backfill sync keep current. The KV `msgCache` is only the local store for a
// development run with no Convex; hosted runs never read or write it.
function usesCorpus() {
  return isConvexConfigured();
}

export async function upsertMessage(message: Message) {
  if (usesCorpus()) return;
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
  await kvUpsert('msgCache', `${doc.account}:${doc._id}`, doc, `${doc.account}:${doc.threadId}`);
}

function byDate(a: Message, b: Message) {
  return Number(a.date || 0) - Number(b.date || 0);
}

function ownerId(userId?: string | null) {
  return userId || requireStoreUserId();
}

async function corpusThread(userId: string, account: string, threadId: string): Promise<Message[]> {
  const bundle = await convexQuery<{ messages?: Message[] } | null>(corpusApi.getCorpusThreadBundle, {
    userId,
    accountId: account,
    providerThreadId: threadId,
  }).catch(() => null);
  return bundle?.messages || [];
}

/**
 * The full thread, oldest first: the corpus, then the provider. A thread that
 * neither source knows comes back empty. No partial cache ever stands in for
 * the full thread in a hosted run.
 */
export async function resolveThreadMessages(
  account: string,
  threadId: string,
  options: { userId?: string | null } = {},
): Promise<Message[]> {
  const userId = ownerId(options.userId);
  if (usesCorpus()) {
    const stored = await corpusThread(userId, account, threadId);
    if (stored.length) return [...stored].sort(byDate);
  } else {
    const local = await kvList<Message>('msgCache', { ref: `${account}:${threadId}` });
    if (local.length) return local.sort(byDate);
  }
  const thread = await getNylasThread({ userId, account, threadId }).catch(() => null);
  return (thread?.messages || []).filter((message) => message._id).sort(byDate);
}

/**
 * One exact message: the corpus (thread bundle when the thread is known, else
 * the message index), then the provider. Never substitutes another message.
 */
export async function resolveMessage(
  account: string,
  messageId: string,
  options: { userId?: string | null; threadId?: string } = {},
): Promise<Message | null> {
  const userId = ownerId(options.userId);
  if (usesCorpus()) {
    if (options.threadId) {
      const match = (await corpusThread(userId, account, options.threadId)).find(
        (message) => message._id === messageId,
      );
      if (match) return match;
    }
    const stored = await convexQuery<Message | null>(corpusApi.getCorpusMessage, {
      userId,
      accountId: account,
      providerMessageId: messageId,
    }).catch(() => null);
    if (stored) return stored;
  } else {
    const local = await kvGet<Message>('msgCache', `${account}:${messageId}`);
    if (local) return local;
  }
  return await getNylasMessage({ userId, account, id: messageId }).catch(() => null);
}

export async function getMessage(account: string, id: string): Promise<Message | null> {
  return await resolveMessage(account, id);
}

export async function getThreadMessages(account: string, threadId: string): Promise<Message[]> {
  return await resolveThreadMessages(account, threadId);
}

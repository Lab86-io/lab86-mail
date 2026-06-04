import type { CreateAttachmentRequest } from 'nylas';
import { assertOutboundSendEnabled } from '@/lib/hosted/controls';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { isConvexConfigured } from '@/lib/hosted/env';
import { requireNylas } from './client';
import {
  emailList,
  normalizeNylasAccount,
  normalizeNylasFolder,
  normalizeNylasMessage,
  normalizeNylasThread,
} from './normalize';

export interface NylasAccountRow {
  userId: string;
  accountId: string;
  email: string;
  provider: 'google' | 'microsoft' | 'icloud' | 'imap';
  status: string;
  displayName?: string;
  grantId: string;
  scopes: string[];
}

export async function listNylasAccounts(userId?: string | null) {
  if (!userId || !isConvexConfigured()) return [];
  const rows = await convexQuery<NylasAccountRow[]>(api.accounts.listConnectedAccounts, { userId });
  return rows.filter((row) => row.status === 'connected').map(normalizeNylasAccount);
}

export async function getNylasAccount(userId: string | null | undefined, email: string) {
  if (!userId || !isConvexConfigured()) return null;
  const row = await convexQuery<NylasAccountRow | null>(api.accounts.getConnectedAccountByEmail, {
    userId,
    email,
  });
  return row?.status === 'connected' ? row : null;
}

export async function searchNylasThreads({
  userId,
  account,
  query,
  max,
  pageToken,
}: {
  userId?: string | null;
  account: string;
  query: string;
  max: number;
  pageToken?: string;
}) {
  assertOutboundSendEnabled();
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const queryParams: Record<string, unknown> = {
    limit: Math.min(max, 80),
    search_query_native: query,
  };
  if (pageToken) queryParams.page_token = pageToken;
  if (/\bis:unread\b/.test(query)) queryParams.unread = true;
  if (/\bis:starred\b/.test(query)) queryParams.starred = true;
  if (/\bhas:attachment\b/.test(query)) queryParams.has_attachment = true;
  const result = await requireNylas().threads.list({
    identifier: row.grantId,
    queryParams: queryParams as any,
  });
  const page = await result;
  const items = page.data.map((thread) => normalizeNylasThread(thread, row.email));
  return { account: row.email, query, items, nextPageToken: page.nextCursor };
}

export async function getNylasThread({
  userId,
  account,
  threadId,
}: {
  userId?: string | null;
  account: string;
  threadId: string;
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const messagesPage = await requireNylas().messages.list({
    identifier: row.grantId,
    queryParams: { threadId, limit: 200 },
  });
  const messages = (await messagesPage).data
    .map((message) => normalizeNylasMessage(message, row.email))
    .sort((a, b) => Number(a.date || 0) - Number(b.date || 0));
  return {
    account: row.email,
    threadId,
    subject: messages[0]?.subject || '(no subject)',
    messages,
  };
}

export async function getNylasMessage({
  userId,
  account,
  id,
}: {
  userId?: string | null;
  account: string;
  id: string;
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const result = await requireNylas().messages.find({ identifier: row.grantId, messageId: id });
  return normalizeNylasMessage(result.data, row.email);
}

export async function listNylasLabels(userId: string | null | undefined, account: string) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const result = await requireNylas().folders.list({ identifier: row.grantId, queryParams: { limit: 200 } });
  return { labels: (await result).data.map(normalizeNylasFolder) };
}

export async function updateNylasThread({
  userId,
  account,
  threadId,
  unread,
  starred,
  folders,
}: {
  userId?: string | null;
  account: string;
  threadId: string;
  unread?: boolean;
  starred?: boolean;
  folders?: string[];
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  await requireNylas().threads.update({
    identifier: row.grantId,
    threadId,
    requestBody: { unread, starred, folders },
  });
  return { ok: true };
}

export async function updateNylasMessage({
  userId,
  account,
  messageId,
  unread,
  starred,
  folders,
}: {
  userId?: string | null;
  account: string;
  messageId: string;
  unread?: boolean;
  starred?: boolean;
  folders?: string[];
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  await requireNylas().messages.update({
    identifier: row.grantId,
    messageId,
    requestBody: { unread, starred, folders },
  });
  return { ok: true };
}

export async function sendNylasMessage({
  userId,
  account,
  to,
  cc,
  bcc,
  subject,
  body,
  html,
  replyToMessageId,
  sendAt,
  attachments,
}: {
  userId?: string | null;
  account: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  html?: string;
  replyToMessageId?: string;
  sendAt?: number;
  attachments?: CreateAttachmentRequest[];
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const result = await requireNylas().messages.send({
    identifier: row.grantId,
    requestBody: {
      to: emailList(to),
      cc: emailList(cc),
      bcc: emailList(bcc),
      subject,
      body: html || body,
      isPlaintext: !html,
      replyToMessageId,
      sendAt: sendAt ? Math.floor(sendAt / 1000) : undefined,
      attachments,
    },
  });
  return normalizeNylasMessage(result.data, row.email);
}

export async function downloadNylasAttachment({
  userId,
  account,
  messageId,
  attachmentId,
}: {
  userId?: string | null;
  account: string;
  messageId: string;
  attachmentId: string;
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  return await requireNylas().attachments.download({
    identifier: row.grantId,
    attachmentId,
    queryParams: { messageId },
  });
}

export async function deleteNylasAccount(userId: string, accountId: string, grantId?: string) {
  if (grantId) {
    await requireNylas()
      .grants.destroy({ grantId })
      .catch(() => undefined);
  }
  await convexMutation(api.accounts.deleteConnectedAccount, { userId, accountId });
  return { ok: true };
}

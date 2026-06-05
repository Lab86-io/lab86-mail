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

export async function createNylasFolder({
  userId,
  account,
  name,
}: {
  userId?: string | null;
  account: string;
  name: string;
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const existing = await findNylasFolder(row.grantId, name);
  if (existing) return normalizeNylasFolder(existing);
  const result = await requireNylas().folders.create({
    identifier: row.grantId,
    requestBody: { name },
  });
  return normalizeNylasFolder(result.data);
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

export async function updateNylasMessageFolders({
  userId,
  account,
  messageId,
  add = [],
  remove = [],
  createMissing = false,
}: {
  userId?: string | null;
  account: string;
  messageId: string;
  add?: string[];
  remove?: string[];
  createMissing?: boolean;
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const current = await requireNylas().messages.find({ identifier: row.grantId, messageId });
  const folders = await applyFolderDelta(row.grantId, current.data.folders || [], {
    add,
    remove,
    createMissing,
  });
  await requireNylas().messages.update({
    identifier: row.grantId,
    messageId,
    requestBody: { folders },
  });
  return { ok: true };
}

export async function updateNylasThreadFolders({
  userId,
  account,
  threadId,
  add = [],
  remove = [],
  createMissing = false,
}: {
  userId?: string | null;
  account: string;
  threadId: string;
  add?: string[];
  remove?: string[];
  createMissing?: boolean;
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const current = await requireNylas().threads.find({ identifier: row.grantId, threadId });
  const folders = await applyFolderDelta(row.grantId, current.data.folders || [], {
    add,
    remove,
    createMissing,
  });
  await requireNylas().threads.update({
    identifier: row.grantId,
    threadId,
    requestBody: { folders },
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
  assertOutboundSendEnabled();
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

async function applyFolderDelta(
  grantId: string,
  currentFolders: string[],
  {
    add,
    remove,
    createMissing,
  }: {
    add: string[];
    remove: string[];
    createMissing: boolean;
  },
) {
  const folders = [...new Set(currentFolders.filter(Boolean))];
  const removeIds = new Set<string>();
  for (const label of remove.map((value) => value.trim()).filter(Boolean)) {
    removeIds.add(label);
    const existing = await findNylasFolder(grantId, label);
    if (existing?.id) removeIds.add(existing.id);
  }

  const next = folders.filter((folder) => !removeIds.has(folder));
  for (const label of add.map((value) => value.trim()).filter(Boolean)) {
    const folderId = await resolveNylasFolderId(grantId, label, createMissing);
    if (folderId && !next.includes(folderId)) next.push(folderId);
  }
  return next;
}

async function resolveNylasFolderId(grantId: string, label: string, createMissing: boolean) {
  const existing = await findNylasFolder(grantId, label);
  if (existing?.id) return existing.id;
  if (!createMissing || isSystemFolderId(label)) return label;
  const created = await requireNylas().folders.create({
    identifier: grantId,
    requestBody: { name: label },
  });
  return created.data.id;
}

async function findNylasFolder(grantId: string, label: string) {
  const normalized = label.toLowerCase();
  const result = await requireNylas().folders.list({ identifier: grantId, queryParams: { limit: 200 } });
  return (await result).data.find(
    (folder) => folder.id === label || folder.name === label || folder.name?.toLowerCase() === normalized,
  );
}

function isSystemFolderId(label: string) {
  return SYSTEM_FOLDER_IDS.has(label.toUpperCase());
}

const SYSTEM_FOLDER_IDS = new Set([
  'ARCHIVE',
  'DRAFT',
  'DRAFTS',
  'IMPORTANT',
  'INBOX',
  'JUNK',
  'MUTE',
  'SENT',
  'SPAM',
  'STARRED',
  'TRASH',
  'UNREAD',
]);

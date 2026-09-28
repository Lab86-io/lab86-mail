// Gmail: messages, threads, folders (labels), attachments, scheduled sends,
// and grants, in the Nylas SDK shapes (docs/google-direct-transport.md).
//
// Every method takes the Nylas SDK arguments and returns the Nylas result
// shape: lists `{ data, requestId, nextCursor? }`, finds `{ data, requestId }`.
// Query parameters come in camelCase or snake_case (callers pass both).

import { randomBytes } from 'node:crypto';
import { api, convexMutation } from '@/lib/hosted/convex';
import { decryptSecret } from '@/lib/security/crypto';
import { GoogleApiError } from '../errors';
import {
  decodeBase64Url,
  type GmailLabel,
  type GmailMessage,
  type GmailThread,
  gmailLabelToNylasFolder,
  gmailMessageToNylas,
  gmailThreadToNylas,
  headerValue,
  type NylasEmailName,
  resolveAttachmentPart,
  threadLabelIds,
} from '../gmail-message';
import { GMAIL_API, googleJson, googleUrl } from '../http';
import { buildMimeMessage, type MimeAttachment, replyReferences } from '../mime';
import { revokeGoogleToken } from '../oauth';
import {
  cancelGoogleScheduledSend,
  findGoogleScheduledSend,
  listGoogleScheduledSends,
  nylasScheduledMessage,
  scheduleGoogleSend,
} from '../scheduled';
import { driveUsesMailGrant, googleRevokeBlockedReason } from '../shared-grant';
import { forgetGoogleAccessToken, type GoogleGrantCredentials, loadGoogleGrantCredentials } from '../tokens';
import type { GoogleNylasAdapter } from './types';

const REQUEST_ID = 'google-direct';
/** Parallel `messages.get` calls. Each costs 5 of the 250 quota units per user per second. */
const GET_CONCURRENCY = 5;
const LABEL_CACHE_MS = 60_000;
const LABEL_CACHE_MAX = 500;
const UPLOAD_SEND_URL = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send';
/** The time limit of a request with a large body: a send (35 MB maximum) or an attachment read. */
export const LARGE_BODY_TIMEOUT_MS = 120_000;
/** A send with a send time further out than this is held in the outbox. */
const SCHEDULE_THRESHOLD_MS = 5_000;
/** Labels that `modify` cannot add or remove. */
const FIXED_LABELS = new Set(['DRAFT', 'SENT', 'CHAT']);
/** Labels that only the unread and starred flags change, never a folder set. */
const FLAG_LABELS = new Set(['UNREAD', 'STARRED']);
const THREAD_METADATA_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date'];

const defaults = {
  loadCredentials: loadGoogleGrantCredentials,
  mutate: convexMutation,
  decryptSecret,
  revokeGoogleToken: (token: string) => revokeGoogleToken(token),
  driveUsesMailGrant,
  googleRevokeBlockedReason,
  destroyNylasGrant: async (grantId: string) => {
    // A dynamic import: lib/nylas/client.ts imports this adapter.
    const { requireNylas } = await import('@/lib/nylas/client');
    await requireNylas().grants.destroy({ grantId });
  },
  scheduleGoogleSend,
  listGoogleScheduledSends,
  findGoogleScheduledSend,
  cancelGoogleScheduledSend,
  boundary: () => `lab86_upload_${randomBytes(12).toString('hex')}`,
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};
let deps = defaults;
const labelCache = new Map<string, { at: number; labels: GmailLabel[] }>();

export function __setGoogleMailAdapterDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
  labelCache.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function param(source: Record<string, unknown> | undefined, ...names: string[]): unknown {
  for (const name of names) {
    const value = source?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function clampLimit(value: unknown, fallback: number, max: number) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function seconds(value: unknown): number | undefined {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function enc(id: unknown) {
  return encodeURIComponent(String(id ?? ''));
}

function wantsHeaders(queryParams: Record<string, unknown> | undefined) {
  const fields = param(queryParams, 'fields');
  return typeof fields === 'string' && fields.includes('include_headers');
}

function statusOf(err: unknown) {
  return Number((err as { statusCode?: unknown })?.statusCode);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function quoteTerm(value: unknown) {
  const text = String(value ?? '').trim();
  return /[\s"()]/.test(text) ? `"${text.replace(/"/g, '')}"` : text;
}

/** The Gmail `q`, `labelIds`, and `includeSpamTrash` of Nylas list parameters. */
export function gmailListQuery(queryParams: Record<string, unknown> = {}) {
  const terms: string[] = [];
  const native = param(queryParams, 'searchQueryNative', 'search_query_native');
  if (native) terms.push(String(native));
  const after = seconds(param(queryParams, 'receivedAfter', 'received_after'));
  if (after) terms.push(`after:${after}`);
  const before = seconds(param(queryParams, 'receivedBefore', 'received_before'));
  if (before) terms.push(`before:${before}`);
  const unread = param(queryParams, 'unread');
  if (unread === true || unread === 'true') terms.push('is:unread');
  if (unread === false || unread === 'false') terms.push('-is:unread');
  const starred = param(queryParams, 'starred');
  if (starred === true || starred === 'true') terms.push('is:starred');
  if (starred === false || starred === 'false') terms.push('-is:starred');
  const hasAttachment = param(queryParams, 'hasAttachment', 'has_attachment');
  if (hasAttachment === true || hasAttachment === 'true') terms.push('has:attachment');
  for (const [key, operator] of [
    ['from', 'from'],
    ['to', 'to'],
    ['cc', 'cc'],
    ['bcc', 'bcc'],
    ['subject', 'subject'],
  ] as const) {
    const value = param(queryParams, key);
    for (const item of Array.isArray(value) ? value : value ? [value] : []) {
      terms.push(`${operator}:${quoteTerm(item)}`);
    }
  }
  const anyEmail = param(queryParams, 'anyEmail', 'any_email');
  for (const email of Array.isArray(anyEmail) ? anyEmail : anyEmail ? [anyEmail] : []) {
    const value = quoteTerm(email);
    terms.push(`{from:${value} to:${value} cc:${value} bcc:${value}}`);
  }
  const folders = param(queryParams, 'in');
  const labelIds = (Array.isArray(folders) ? folders : folders ? [folders] : []).map(String).filter(Boolean);
  return {
    q: terms.join(' ') || undefined,
    labelIds,
    // A plain list reads the whole mailbox, as Nylas does, so the repair sweep
    // sees mail that moved to Trash or Spam. A native search keeps Gmail's own
    // search rules.
    includeSpamTrash: !native,
  };
}

async function listPage<T>(
  grantId: string,
  resource: 'messages' | 'threads',
  queryParams: any,
  limit: number,
) {
  const { q, labelIds, includeSpamTrash } = gmailListQuery(queryParams);
  const pageToken = param(queryParams, 'pageToken', 'page_token');
  try {
    return await googleJson<T>(
      grantId,
      googleUrl(`${GMAIL_API}/${resource}`, {
        maxResults: limit,
        pageToken,
        q,
        labelIds,
        includeSpamTrash: includeSpamTrash || undefined,
      }),
    );
  } catch (err) {
    // The corpus backfill restarts from the top when the error names the
    // page token (isInvalidCursorError), so say so.
    if (pageToken && statusOf(err) === 400) {
      throw new GoogleApiError(400, `Invalid page_token: ${(err as Error).message}`, 'invalidPageToken');
    }
    throw err;
  }
}

async function getMessage(grantId: string, messageId: string, format: 'full' | 'minimal' | 'metadata') {
  return await googleJson<GmailMessage>(
    grantId,
    googleUrl(`${GMAIL_API}/messages/${enc(messageId)}`, { format }),
  );
}

/** A message that is gone between the list and the read is skipped. */
async function getMessageOrNull(grantId: string, messageId: string) {
  try {
    return await getMessage(grantId, messageId, 'full');
  } catch (err) {
    if (statusOf(err) === 404) return null;
    throw err;
  }
}

async function getThread(grantId: string, threadId: string, format: 'full' | 'minimal' | 'metadata') {
  return await googleJson<GmailThread>(
    grantId,
    googleUrl(`${GMAIL_API}/threads/${enc(threadId)}`, {
      format,
      ...(format === 'metadata' ? { metadataHeaders: THREAD_METADATA_HEADERS } : {}),
    }),
  );
}

async function requireCredentials(grantId: string): Promise<GoogleGrantCredentials> {
  const credentials = await deps.loadCredentials(grantId);
  if (!credentials) {
    throw new GoogleApiError(
      401,
      'invalid_grant: no Google sign-in is stored for this mailbox.',
      'invalid_grant',
    );
  }
  return credentials;
}

/**
 * Label changes for Nylas `{ unread, starred, folders }`. A folder set
 * replaces the labels, but UNREAD and STARRED follow only the two flags, and
 * DRAFT, SENT, and CHAT cannot change. A true flag adds its label and a false
 * flag removes it, whatever the current labels are.
 */
export function labelDelta(
  current: string[],
  body: { unread?: unknown; starred?: unknown; folders?: unknown } = {},
): { addLabelIds: string[]; removeLabelIds: string[] } {
  const add = new Set<string>();
  const remove = new Set<string>();
  if (Array.isArray(body.folders)) {
    const desired = new Set(body.folders.map(String).filter((id) => id && !FLAG_LABELS.has(id)));
    for (const id of desired) if (!current.includes(id)) add.add(id);
    for (const id of current) if (!desired.has(id) && !FLAG_LABELS.has(id)) remove.add(id);
  }
  for (const [flag, label] of [
    [body.unread, 'UNREAD'],
    [body.starred, 'STARRED'],
  ] as const) {
    // The current labels are read only for a folder set, so a flag never
    // depends on them: Gmail accepts adding a label that is there and
    // removing one that is not.
    if (flag === true) {
      remove.delete(label);
      add.add(label);
    } else if (flag === false) {
      add.delete(label);
      remove.add(label);
    }
  }
  for (const id of FIXED_LABELS) {
    add.delete(id);
    remove.delete(id);
  }
  return { addLabelIds: [...add], removeLabelIds: [...remove] };
}

function needsCurrentLabels(body: { folders?: unknown } | undefined) {
  return Array.isArray(body?.folders);
}

function recipients(list: unknown): NylasEmailName[] {
  return (Array.isArray(list) ? list : [])
    .filter((item: any) => item?.email)
    .map((item: any) => ({ name: String(item.name || ''), email: String(item.email) }));
}

async function attachmentContent(content: unknown): Promise<Uint8Array | string> {
  if (typeof content === 'string' || content instanceof Uint8Array) return content;
  if (content && typeof (content as any)[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of content as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new GoogleApiError(400, 'An attachment has content that Gmail cannot send.');
}

async function mimeAttachments(list: unknown): Promise<MimeAttachment[]> {
  const out: MimeAttachment[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    out.push({
      filename: item?.filename,
      contentType: item?.contentType ?? item?.content_type,
      content: await attachmentContent(item?.content),
      contentId: item?.contentId ?? item?.content_id,
      isInline: Boolean(item?.isInline ?? item?.is_inline),
    });
  }
  return out;
}

/** `users.messages.send` through the upload endpoint (up to 35 MB), with the thread id. */
async function sendRaw(grantId: string, mime: string, threadId?: string) {
  const boundary = deps.boundary();
  const metadata = JSON.stringify(threadId ? { threadId } : {});
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    'Content-Type: message/rfc822',
    '',
    mime,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return await googleJson<GmailMessage>(grantId, googleUrl(UPLOAD_SEND_URL, { uploadType: 'multipart' }), {
    method: 'POST',
    headers: { 'content-type': `multipart/related; boundary=${boundary}` },
    body,
    retryServerErrors: false,
    timeoutMs: LARGE_BODY_TIMEOUT_MS,
  });
}

function sentShape(input: {
  id: string;
  threadId?: string;
  grantId: string;
  requestBody: any;
  from: NylasEmailName[];
  date: number;
  folders: string[];
  scheduleId?: string;
}) {
  const body = input.requestBody || {};
  return {
    id: input.id,
    object: 'message' as const,
    grantId: input.grantId,
    threadId: input.threadId || input.id,
    subject: String(body.subject ?? ''),
    from: input.from,
    to: recipients(body.to),
    cc: recipients(body.cc),
    bcc: recipients(body.bcc),
    replyTo: recipients(body.replyTo),
    date: input.date,
    createdAt: input.date,
    snippet: '',
    body: String(body.body ?? ''),
    unread: false,
    starred: false,
    folders: input.folders,
    attachments: [],
    ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

async function listMessages(args: any) {
  const grantId = String(args?.identifier);
  const queryParams = args?.queryParams || {};
  const includeHeaders = wantsHeaders(queryParams);
  const limit = clampLimit(param(queryParams, 'limit'), 50, 200);
  const threadId = param(queryParams, 'threadId', 'thread_id');
  if (threadId) {
    let thread: GmailThread;
    try {
      thread = await getThread(grantId, String(threadId), 'full');
    } catch (err) {
      if (statusOf(err) === 404) return { data: [], requestId: REQUEST_ID };
      throw err;
    }
    const data = (thread.messages || [])
      .filter((message) => !(message.labelIds || []).includes('DRAFT'))
      .map((message) => gmailMessageToNylas(message, grantId, { includeHeaders }))
      .sort((a, b) => b.date - a.date)
      .slice(0, limit);
    return { data, requestId: REQUEST_ID };
  }
  const page = await listPage<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
    grantId,
    'messages',
    queryParams,
    limit,
  );
  const fetched = await mapLimit(page.messages || [], GET_CONCURRENCY, (ref) =>
    getMessageOrNull(grantId, ref.id),
  );
  const data = fetched
    .filter((message): message is GmailMessage => Boolean(message))
    .filter((message) => !(message.labelIds || []).includes('DRAFT'))
    .map((message) => gmailMessageToNylas(message, grantId, { includeHeaders }));
  return { data, requestId: REQUEST_ID, nextCursor: page.nextPageToken || undefined };
}

async function findMessage(args: any) {
  const grantId = String(args?.identifier);
  const message = await getMessage(grantId, String(args?.messageId), 'full');
  return {
    data: gmailMessageToNylas(message, grantId, { includeHeaders: wantsHeaders(args?.queryParams) }),
    requestId: REQUEST_ID,
  };
}

async function updateMessage(args: any) {
  const grantId = String(args?.identifier);
  const messageId = String(args?.messageId);
  const body = args?.requestBody || {};
  const current = needsCurrentLabels(body)
    ? (await getMessage(grantId, messageId, 'minimal')).labelIds || []
    : [];
  const delta = labelDelta(current, body);
  const updated =
    delta.addLabelIds.length || delta.removeLabelIds.length
      ? await googleJson<GmailMessage>(grantId, `${GMAIL_API}/messages/${enc(messageId)}/modify`, {
          method: 'POST',
          json: delta,
        })
      : await getMessage(grantId, messageId, 'minimal');
  return { data: gmailMessageToNylas(updated, grantId), requestId: REQUEST_ID };
}

async function sendMessage(args: any) {
  const grantId = String(args?.identifier);
  const body = args?.requestBody || {};
  const credentials = await requireCredentials(grantId);
  const from = [{ name: '', email: credentials.email }];
  const sendAtSeconds = Number(body.sendAt ?? body.send_at);
  if (Number.isFinite(sendAtSeconds) && sendAtSeconds * 1000 > deps.now() + SCHEDULE_THRESHOLD_MS) {
    const receipt = await deps.scheduleGoogleSend(credentials, body, sendAtSeconds * 1000);
    return {
      data: sentShape({
        id: receipt.key,
        grantId,
        requestBody: body,
        from,
        date: Math.floor(receipt.fireAt / 1000),
        folders: [],
        scheduleId: receipt.key,
      }),
      requestId: REQUEST_ID,
    };
  }
  const replyToMessageId = body.replyToMessageId ?? body.reply_to_message_id;
  const parent = replyToMessageId
    ? await googleJson<GmailMessage>(
        grantId,
        googleUrl(`${GMAIL_API}/messages/${enc(replyToMessageId)}`, {
          format: 'metadata',
          metadataHeaders: ['Message-ID', 'References'],
        }),
      )
    : null;
  const parentMessageId = parent ? headerValue(parent.payload?.headers, 'Message-ID') : undefined;
  const mime = buildMimeMessage({
    to: recipients(body.to),
    cc: recipients(body.cc),
    bcc: recipients(body.bcc),
    replyTo: recipients(body.replyTo ?? body.reply_to),
    subject: String(body.subject ?? ''),
    body: String(body.body ?? ''),
    isPlaintext: body.isPlaintext === true || body.is_plaintext === true,
    inReplyTo: parentMessageId,
    references: replyReferences(parentMessageId, headerValue(parent?.payload?.headers, 'References')),
    attachments: await mimeAttachments(body.attachments),
  });
  const sent = await sendRaw(grantId, mime, parent?.threadId);
  return {
    data: sentShape({
      id: sent.id,
      threadId: sent.threadId,
      grantId,
      requestBody: body,
      from,
      date: Math.floor(deps.now() / 1000),
      folders: sent.labelIds || ['SENT'],
    }),
    requestId: REQUEST_ID,
  };
}

async function listScheduledMessages(args: any) {
  const credentials = await requireCredentials(String(args?.identifier));
  const rows = await deps.listGoogleScheduledSends(credentials);
  return { data: rows.map(nylasScheduledMessage), requestId: REQUEST_ID };
}

async function findScheduledMessage(args: any) {
  const credentials = await requireCredentials(String(args?.identifier));
  const row = await deps.findGoogleScheduledSend(credentials, String(args?.scheduleId));
  if (!row) throw new GoogleApiError(404, 'The scheduled message was not found.');
  return { data: nylasScheduledMessage(row), requestId: REQUEST_ID };
}

async function stopScheduledMessage(args: any) {
  const credentials = await requireCredentials(String(args?.identifier));
  const stopped = await deps.cancelGoogleScheduledSend(credentials, String(args?.scheduleId));
  if (!stopped) throw new GoogleApiError(409, 'The scheduled message was already sent or cancelled.');
  return { data: { message: 'The scheduled message was cancelled.' }, requestId: REQUEST_ID };
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

async function listThreads(args: any) {
  const grantId = String(args?.identifier);
  const queryParams = args?.queryParams || {};
  const limit = clampLimit(param(queryParams, 'limit'), 20, 100);
  const page = await listPage<{ threads?: Array<{ id: string; snippet?: string }>; nextPageToken?: string }>(
    grantId,
    'threads',
    queryParams,
    limit,
  );
  const threads = await mapLimit(
    page.threads || [],
    GET_CONCURRENCY,
    async (ref): Promise<GmailThread | null> => {
      try {
        const thread = await getThread(grantId, ref.id, 'metadata');
        return { ...thread, snippet: ref.snippet ?? thread.snippet };
      } catch (err) {
        if (statusOf(err) === 404) return null;
        throw err;
      }
    },
  );
  const data = threads
    .filter((thread): thread is GmailThread => Boolean(thread))
    .map((thread) => gmailThreadToNylas(thread, grantId))
    .filter((thread) => thread.messageIds.length > 0);
  return { data, requestId: REQUEST_ID, nextCursor: page.nextPageToken || undefined };
}

async function findThread(args: any) {
  const grantId = String(args?.identifier);
  const thread = await getThread(grantId, String(args?.threadId), 'metadata');
  return { data: gmailThreadToNylas(thread, grantId), requestId: REQUEST_ID };
}

async function updateThread(args: any) {
  const grantId = String(args?.identifier);
  const threadId = String(args?.threadId);
  const body = args?.requestBody || {};
  // Gmail thread labels are the union of the message labels, as Nylas has them.
  const current = needsCurrentLabels(body)
    ? threadLabelIds(await getThread(grantId, threadId, 'minimal'))
    : [];
  const delta = labelDelta(current, body);
  const updated =
    delta.addLabelIds.length || delta.removeLabelIds.length
      ? await googleJson<GmailThread>(grantId, `${GMAIL_API}/threads/${enc(threadId)}/modify`, {
          method: 'POST',
          json: delta,
        })
      : await getThread(grantId, threadId, 'minimal');
  return { data: gmailThreadToNylas(updated, grantId), requestId: REQUEST_ID };
}

// ---------------------------------------------------------------------------
// Folders (Gmail labels)
// ---------------------------------------------------------------------------

async function gmailLabels(grantId: string): Promise<GmailLabel[]> {
  const cached = labelCache.get(grantId);
  if (cached && deps.now() - cached.at < LABEL_CACHE_MS) return cached.labels;
  const result = await googleJson<{ labels?: GmailLabel[] }>(grantId, `${GMAIL_API}/labels`);
  const labels = result?.labels || [];
  if (!labelCache.has(grantId) && labelCache.size >= LABEL_CACHE_MAX) {
    const oldest = labelCache.keys().next().value;
    if (oldest !== undefined) labelCache.delete(oldest);
  }
  labelCache.set(grantId, { at: deps.now(), labels });
  return labels;
}

async function listFolders(args: any) {
  const grantId = String(args?.identifier);
  const labels = await gmailLabels(grantId);
  return { data: labels.map((label) => gmailLabelToNylasFolder(label, grantId)), requestId: REQUEST_ID };
}

async function findFolder(args: any) {
  const grantId = String(args?.identifier);
  const label = await googleJson<GmailLabel>(grantId, `${GMAIL_API}/labels/${enc(args?.folderId)}`);
  return { data: gmailLabelToNylasFolder(label, grantId), requestId: REQUEST_ID };
}

async function createFolder(args: any) {
  const grantId = String(args?.identifier);
  const name = String(args?.requestBody?.name || '').trim();
  if (!name) throw new GoogleApiError(400, 'A label name is required.');
  const label = await googleJson<GmailLabel>(grantId, `${GMAIL_API}/labels`, {
    method: 'POST',
    json: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  });
  labelCache.delete(grantId);
  return { data: gmailLabelToNylasFolder({ type: 'user', ...label }, grantId), requestId: REQUEST_ID };
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

async function downloadAttachment(args: any): Promise<ReadableStream<Uint8Array>> {
  const grantId = String(args?.identifier);
  const messageId = param(args?.queryParams, 'messageId', 'message_id');
  if (!messageId) throw new GoogleApiError(400, 'A message id is required to download a Gmail attachment.');
  const message = await getMessage(grantId, String(messageId), 'full');
  const part = resolveAttachmentPart(message.payload, String(args?.attachmentId));
  if (!part) throw new GoogleApiError(404, 'The attachment was not found in the message.');
  let bytes: Buffer;
  if (part.body?.data) bytes = decodeBase64Url(part.body.data);
  else if (part.body?.attachmentId) {
    const result = await googleJson<{ data?: string }>(
      grantId,
      `${GMAIL_API}/messages/${enc(messageId)}/attachments/${enc(part.body.attachmentId)}`,
      { timeoutMs: LARGE_BODY_TIMEOUT_MS },
    );
    bytes = decodeBase64Url(result?.data);
  } else bytes = Buffer.alloc(0);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

async function findGrant(args: any) {
  const grantId = String(args?.grantId);
  const credentials = await deps.loadCredentials(grantId);
  if (!credentials) throw new GoogleApiError(404, 'No grant found for this direct Google account.');
  return {
    data: {
      id: grantId,
      provider: 'google',
      grantStatus: credentials.refreshTokenEncrypted ? 'valid' : 'invalid',
      email: credentials.email,
      scope: credentials.scopes || [],
    },
    requestId: REQUEST_ID,
  };
}

const REVOKE_ATTEMPTS = 3;

/**
 * Revokes a token at Google. A network error, a 429, or a 5xx gets another
 * try. The caller deletes the token row after this whatever the result.
 */
async function revokeWithRetry(token: string, attempt = 1): Promise<boolean> {
  try {
    return await deps.revokeGoogleToken(token);
  } catch (err: any) {
    const status = statusOf(err);
    const transient = !Number.isFinite(status) || status === 0 || status === 429 || status >= 500;
    if (!transient || attempt >= REVOKE_ATTEMPTS) {
      console.warn('[google-mail] token revoke failed', status || err?.message || err);
      return false;
    }
    await deps.sleep(250 * 2 ** (attempt - 1));
    return await revokeWithRetry(token, attempt + 1);
  }
}

/** The stored token in plain text, or null when it cannot be read. */
function readStoredToken(encrypted: string): string | null {
  try {
    return deps.decryptSecret(encrypted);
  } catch (err: any) {
    console.warn('[google-mail] could not read the stored token to revoke it', err?.message || err);
    return null;
  }
}

/**
 * Removes a direct grant: revokes the Google token, deletes the token row
 * (and the scheduled sends of the account), and destroys the Nylas grant that
 * the account used before the switch. A failed revoke is logged; the token
 * row goes anyway, so no copy of the token stays with us. When a Drive
 * connection of the same user and address uses the same OAuth client, the
 * revoke would end it too (lib/google/shared-grant.ts), so it is left out.
 * The revoke is also left out outside the production deployment, and while
 * another Google connection of any user in this deployment (a mail account
 * or a Drive connection) uses the same address.
 */
async function destroyGrant(args: any) {
  const grantId = String(args?.grantId);
  const credentials = await deps.loadCredentials(grantId).catch(() => null);
  const token = credentials?.refreshTokenEncrypted || credentials?.accessTokenEncrypted;
  const plain = token ? readStoredToken(token) : null;
  if (plain && credentials) {
    const reason = (await deps.driveUsesMailGrant({ userId: credentials.userId, email: credentials.email }))
      ? 'a Drive connection shares this Google grant'
      : await deps.googleRevokeBlockedReason({ email: credentials.email, exceptGrantId: grantId });
    if (reason) console.warn(`[google-mail] no revoke: ${reason}; the token row goes`);
    else await revokeWithRetry(plain);
  }
  forgetGoogleAccessToken(grantId);
  labelCache.delete(grantId);
  const removed = await deps.mutate<{ removed: number; previousNylasGrantIds: string[] }>(
    api.googleDirect.removeGrant,
    { grantId },
  );
  for (const previous of removed?.previousNylasGrantIds || []) {
    await deps.destroyNylasGrant(previous).catch((err: any) => {
      console.warn('[google-mail] previous Nylas grant destroy failed', err?.message || err);
    });
  }
  return { requestId: REQUEST_ID };
}

export const googleMailAdapter: GoogleNylasAdapter = {
  messages: {
    list: listMessages,
    find: findMessage,
    update: updateMessage,
    send: sendMessage,
    listScheduledMessages,
    findScheduledMessage,
    stopScheduledMessage,
  },
  threads: {
    list: listThreads,
    find: findThread,
    update: updateThread,
  },
  folders: {
    list: listFolders,
    find: findFolder,
    create: createFolder,
  },
  attachments: {
    download: downloadAttachment,
  },
  grants: {
    find: findGrant,
    destroy: destroyGrant,
  },
};

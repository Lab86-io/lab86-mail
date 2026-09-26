import { assertPublicHttpUrl } from '../attachments/fetch-store';
import { api, convexMutation } from '../hosted/convex';
import { getNylasMessageHeaders, sendNylasMessage } from '../nylas/provider';
import { emailFromHeader, shortFrom } from '../shared/format';
import type { Message } from '../shared/types';
import { resolveThreadMessages } from '../store/messages';
import { recordMailOperation } from './mail-operations';
import { keptMessageHeaders } from './sender-cleanup';

// Unsubscribe (FEATURES item 13). RFC 8058 one-click first: a POST to the
// https List-Unsubscribe address when List-Unsubscribe-Post says One-Click.
// Then a mailto: request sent from the user's mailbox. Then the sender's web
// page, which the user opens. The request cannot be taken back, so the UI
// asks first and the tool requires `confirmed: true`. It still shows in
// Activity, without Undo.

export type UnsubscribeMethod = 'one_click' | 'mailto' | 'link';

export interface ListUnsubscribeOptions {
  /** https address that accepts the RFC 8058 one-click POST. */
  oneClickUrl?: string;
  /** Web page for a manual unsubscribe. */
  httpUrl?: string;
  mailto?: { to: string; subject: string; body: string };
}

function listEntries(value: string) {
  const bracketed = [...value.matchAll(/<([^>]+)>/g)].map((match) => match[1].trim());
  if (bracketed.length) return bracketed;
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseMailto(uri: string) {
  const rest = uri.replace(/^mailto:/i, '');
  const [address, query = ''] = rest.split('?');
  let to = '';
  try {
    to = decodeURIComponent(address).trim();
  } catch {
    to = address.trim();
  }
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) return undefined;
  const params = new URLSearchParams(query);
  const subject = (params.get('subject') || 'unsubscribe').slice(0, 200);
  const body = (params.get('body') || 'Please unsubscribe me from this list.').slice(0, 2000);
  return { to, subject, body };
}

/** Reads List-Unsubscribe and List-Unsubscribe-Post into the ways to leave a list. */
export function parseListUnsubscribe(
  listUnsubscribe: string | null | undefined,
  listUnsubscribePost?: string | null,
): ListUnsubscribeOptions {
  const out: ListUnsubscribeOptions = {};
  if (!listUnsubscribe?.trim()) return out;
  const oneClickAllowed = /list-unsubscribe\s*=\s*one-click/i.test(listUnsubscribePost || '');
  for (const entry of listEntries(listUnsubscribe)) {
    if (/^mailto:/i.test(entry)) {
      out.mailto ??= parseMailto(entry);
      continue;
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    out.httpUrl ??= url.toString();
    if (oneClickAllowed && url.protocol === 'https:') out.oneClickUrl ??= url.toString();
  }
  return out;
}

export function preferredUnsubscribeMethod(options: ListUnsubscribeOptions): UnsubscribeMethod | null {
  if (options.oneClickUrl) return 'one_click';
  if (options.mailto) return 'mailto';
  if (options.httpUrl) return 'link';
  return null;
}

export interface UnsubscribeTarget {
  account: string;
  threadId: string;
  messageId: string | null;
  sender: string;
  senderEmail: string | null;
  listId: string | null;
  options: ListUnsubscribeOptions;
  method: UnsubscribeMethod | null;
}

export interface UnsubscribeDependencies {
  threadMessages: (account: string, threadId: string, userId: string) => Promise<Message[]>;
  fetchHeaders: typeof getNylasMessageHeaders;
  storeHeaders: (input: {
    userId: string;
    accountId: string;
    providerMessageId: string;
    headers: Record<string, string>;
  }) => Promise<unknown>;
  postOneClick: (url: string) => Promise<{ status: number }>;
  sendMail: typeof sendNylasMessage;
  record: typeof recordMailOperation;
}

/** The RFC 8058 POST. Public https hosts only; redirects are not followed. */
export async function postOneClickUnsubscribe(
  url: string,
  fetchImpl: typeof fetch = fetch,
  assertUrl: (url: string) => Promise<string> = assertPublicHttpUrl,
) {
  const target = await assertUrl(url);
  if (!target.startsWith('https:')) throw new Error('One-click unsubscribe needs a secure (https) address.');
  const response = await fetchImpl(target, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status >= 200 && response.status < 400) return { status: response.status };
  throw new Error(`The sender's unsubscribe service answered with an error (${response.status}).`);
}

const defaultDependencies: UnsubscribeDependencies = {
  threadMessages: (account, threadId, userId) => resolveThreadMessages(account, threadId, { userId }),
  fetchHeaders: getNylasMessageHeaders,
  storeHeaders: (input) => convexMutation(api.mailCorpus.setMessageListHeaders, input),
  postOneClick: (url) => postOneClickUnsubscribe(url),
  sendMail: sendNylasMessage,
  record: recordMailOperation,
};

function headerValue(headers: unknown, name: string) {
  if (!headers || typeof headers !== 'object') return undefined;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === name && typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** The newest message in the thread that the user did not send. */
function listMessage(messages: Message[]) {
  const received = messages.filter(
    (message) => !(message.labels || []).some((label) => label === 'SENT' || label === 'DRAFT'),
  );
  const pool = received.length ? received : messages;
  return pool.reduce<Message | null>(
    (best, message) => (!best || Number(message.date || 0) >= Number(best.date || 0) ? message : best),
    null,
  );
}

/** Finds how this thread's sender lets people leave the list. */
export async function unsubscribeTarget(
  input: { userId: string; account: string; threadId: string },
  deps: UnsubscribeDependencies = defaultDependencies,
): Promise<UnsubscribeTarget> {
  const messages = await deps.threadMessages(input.account, input.threadId, input.userId);
  const message = listMessage(messages);
  if (!message) throw new Error('This thread has no messages to unsubscribe from.');
  let headers: Record<string, string> = { ...(keptMessageHeaders(message.headers) || {}) };
  if (!headerValue(headers, 'list-unsubscribe') && message._id) {
    // Stored mail usually has no headers: webhooks do not carry them. Read
    // them once from the provider and keep the list lines on the message.
    const fetched = await deps
      .fetchHeaders({ userId: input.userId, account: input.account, messageId: message._id })
      .catch(() => null);
    const kept = keptMessageHeaders(fetched);
    if (kept) {
      headers = { ...headers, ...kept };
      await deps
        .storeHeaders({
          userId: input.userId,
          accountId: input.account,
          providerMessageId: message._id,
          headers: kept,
        })
        .catch(() => undefined);
    }
  }
  const options = parseListUnsubscribe(
    headerValue(headers, 'list-unsubscribe'),
    headerValue(headers, 'list-unsubscribe-post'),
  );
  const listHeader = headerValue(headers, 'list-id') || '';
  return {
    account: input.account,
    threadId: input.threadId,
    messageId: message._id || null,
    sender: shortFrom(message.from) || 'this sender',
    senderEmail: emailFromHeader(message.from),
    listId: (listHeader.match(/<([^>]+)>/)?.[1] || listHeader).trim() || null,
    options,
    method: preferredUnsubscribeMethod(options),
  };
}

export type UnsubscribeResult =
  | { status: 'unsubscribed'; method: 'one_click'; sender: string; operationId?: string }
  | { status: 'requested'; method: 'mailto'; sender: string; to: string; operationId?: string }
  | { status: 'open_link'; method: 'link'; sender: string; url: string };

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'the sender';
  }
}

/**
 * Sends the unsubscribe request. One-click and mailto act at once and are
 * recorded in Activity without Undo. A link-only sender returns the page for
 * the user to open.
 */
export async function unsubscribeFromThread(
  input: {
    userId: string;
    account: string;
    threadId: string;
    method?: UnsubscribeMethod;
    agent?: 'user' | 'ai' | 'codex';
    batchId?: string;
  },
  deps: UnsubscribeDependencies = defaultDependencies,
): Promise<UnsubscribeResult> {
  const target = await unsubscribeTarget(input, deps);
  const method = input.method ?? target.method;
  if (!method) {
    throw new Error(`${target.sender} does not offer a way to unsubscribe. Block the sender instead.`);
  }
  const record = (summary: string, reason: string) =>
    deps.record({
      userId: input.userId,
      tool: 'unsubscribe_sender',
      summary,
      reason,
      target: {
        kind: 'sender',
        id: target.senderEmail || target.sender,
        accountId: input.account,
        threadId: input.threadId,
      },
      batchId: input.batchId,
    });
  if (method === 'one_click') {
    const url = target.options.oneClickUrl;
    if (!url) throw new Error(`${target.sender} does not support one-click unsubscribe.`);
    await deps.postOneClick(url);
    const operationId = await record(
      `Unsubscribed from ${target.sender}`,
      `A one-click unsubscribe request went to ${hostOf(url)}. An unsubscribe cannot be undone.`,
    ).catch(() => undefined);
    return { status: 'unsubscribed', method, sender: target.sender, operationId };
  }
  if (method === 'mailto') {
    const mailto = target.options.mailto;
    if (!mailto) throw new Error(`${target.sender} does not take unsubscribe requests by email.`);
    const sent = await deps.sendMail({
      userId: input.userId,
      account: input.account,
      to: mailto.to,
      subject: mailto.subject,
      body: mailto.body,
    });
    if (!sent) throw new Error('Reconnect this mailbox to send the unsubscribe request.');
    const operationId = await record(
      `Asked ${target.sender} to stop sending mail`,
      `An unsubscribe email went to ${mailto.to}. An unsubscribe cannot be undone.`,
    ).catch(() => undefined);
    return { status: 'requested', method, sender: target.sender, to: mailto.to, operationId };
  }
  const url = target.options.httpUrl;
  if (!url) throw new Error(`${target.sender} has no unsubscribe page.`);
  return { status: 'open_link', method: 'link', sender: target.sender, url };
}

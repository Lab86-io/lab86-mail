// Direct Google transport: scheduled sends.
//
// Gmail has no scheduled send. A direct Google account holds a scheduled
// message in the mail outbox (convex mailOutbox) with the future fire time.
// At that time the outbox dispatch (app/api/cron/mail-outbox) calls
// sendNylasMessage with the held payload, which goes to Gmail at once. The
// outbox key (`outbox:<uuid>`) is the schedule id.

import { randomUUID } from 'node:crypto';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import type { OutboxPayload } from '@/lib/send/outbox';
import { GoogleApiError } from './errors';
import type { GoogleGrantCredentials } from './tokens';

export interface ScheduledSendRow {
  key: string;
  accountId?: string;
  fireAt: number;
  status: string;
  messageId?: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const defaults = {
  query: convexQuery,
  mutate: convexMutation,
  fetch: ((input: string, init?: RequestInit) => fetch(input, init)) as FetchLike,
  newKey: () => `outbox:${randomUUID()}`,
};
let deps = defaults;

export function __setGoogleScheduledDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
}

type Recipient = { email?: string; name?: string };

/**
 * The comma-separated form that sendNylasMessage parses again (emailList).
 * A display name with a comma or a quote would break that parse, so such a
 * recipient keeps only the address.
 */
export function recipientsToString(list: Recipient[] | undefined): string | undefined {
  const items = (list || [])
    .filter((item) => item?.email)
    .map((item) => {
      const name = String(item.name || '').trim();
      return name && !/[",<>]/.test(name) ? `${name} <${item.email}>` : String(item.email);
    });
  return items.length ? items.join(', ') : undefined;
}

async function contentBase64(content: unknown): Promise<string> {
  if (typeof content === 'string') return content;
  if (content instanceof Uint8Array) return Buffer.from(content).toString('base64');
  if (content && typeof (content as any)[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of content as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('base64');
  }
  throw new GoogleApiError(400, 'An attachment has content that cannot be held for a scheduled send.');
}

/** The outbox payload of a Nylas send request body. */
export async function outboxPayloadFromSendRequest(
  credentials: Pick<GoogleGrantCredentials, 'userId' | 'accountId'>,
  requestBody: any,
): Promise<OutboxPayload & { userId: string }> {
  // Nylas treats a body as HTML unless isPlaintext is true. The adapter send
  // takes both casings of these fields, so the held payload does too.
  const plain = requestBody?.isPlaintext === true || requestBody?.is_plaintext === true;
  const replyToMessageId = requestBody?.replyToMessageId ?? requestBody?.reply_to_message_id;
  const body = String(requestBody?.body ?? '');
  const attachments = [];
  for (const attachment of requestBody?.attachments || []) {
    attachments.push({
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
      ...(attachment.isInline ? { isInline: true } : {}),
      content: await contentBase64(attachment.content),
    });
  }
  return {
    userId: credentials.userId,
    account: credentials.accountId,
    to: recipientsToString(requestBody?.to) || '',
    cc: recipientsToString(requestBody?.cc),
    bcc: recipientsToString(requestBody?.bcc),
    subject: String(requestBody?.subject ?? ''),
    body,
    ...(plain ? {} : { html: body }),
    ...(replyToMessageId ? { replyToMessageId: String(replyToMessageId) } : {}),
    ...(attachments.length ? { attachments: attachments as any } : {}),
  };
}

/** Holds one message in the outbox until `fireAt` (epoch ms). */
export async function scheduleGoogleSend(
  credentials: Pick<GoogleGrantCredentials, 'userId' | 'accountId'>,
  requestBody: any,
  fireAt: number,
): Promise<{ key: string; fireAt: number }> {
  const payload = await outboxPayloadFromSendRequest(credentials, requestBody);
  const uploadUrl = await deps.mutate<string>(api.mailOutbox.uploadUrl, {});
  const response = await deps.fetch(uploadUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new GoogleApiError(502, 'Could not hold the message. Nothing was scheduled.');
  const { storageId } = (await response.json()) as { storageId: string };
  const key = deps.newKey();
  const receipt = await deps.mutate<{ key: string; fireAt: number }>(api.googleDirect.enqueueScheduledSend, {
    userId: credentials.userId,
    accountId: credentials.accountId,
    key,
    payloadId: storageId,
    fireAt,
  });
  return { key: receipt?.key || key, fireAt: receipt?.fireAt ?? fireAt };
}

export async function listGoogleScheduledSends(
  credentials: Pick<GoogleGrantCredentials, 'userId' | 'accountId'>,
): Promise<ScheduledSendRow[]> {
  return (
    (await deps.query<ScheduledSendRow[]>(api.googleDirect.listScheduledSends, {
      userId: credentials.userId,
      accountId: credentials.accountId,
    })) || []
  );
}

export async function findGoogleScheduledSend(
  credentials: Pick<GoogleGrantCredentials, 'userId' | 'accountId'>,
  key: string,
): Promise<ScheduledSendRow | null> {
  const row = await deps.query<ScheduledSendRow | null>(api.googleDirect.getScheduledSend, {
    userId: credentials.userId,
    key,
  });
  return row && row.accountId === credentials.accountId ? row : null;
}

/** True when the send was stopped; false when it already went (or is going) out. */
export async function cancelGoogleScheduledSend(
  credentials: Pick<GoogleGrantCredentials, 'userId' | 'accountId'>,
  key: string,
): Promise<boolean> {
  const row = await findGoogleScheduledSend(credentials, key);
  if (!row) return false;
  return Boolean(await deps.mutate<boolean>(api.mailOutbox.cancel, { userId: credentials.userId, key }));
}

/**
 * The Nylas status code of an outbox status. Nylas codes: pending,
 * close_to_send_time, success, failed, cancelled. `unknown` means the
 * handoff to Gmail timed out; it is not permission to send again.
 */
export function scheduledStatusCode(status: string): string {
  if (status === 'sent') return 'success';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'sending') return 'close_to_send_time';
  return 'pending';
}

/** One outbox row in the Nylas scheduled-message shape. */
export function nylasScheduledMessage(row: ScheduledSendRow) {
  const code = scheduledStatusCode(row.status);
  return {
    scheduleId: row.key,
    status: { code, description: `The scheduled message is ${code.replace(/_/g, ' ')}.` },
    closeTime: Math.floor(row.fireAt / 1000),
  };
}

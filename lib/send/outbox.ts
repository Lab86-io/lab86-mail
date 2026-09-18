import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import type { sendNylasMessage } from '@/lib/nylas/provider';

const outbox = (api as any).mailOutbox;
export type OutboxPayload = Omit<Parameters<typeof sendNylasMessage>[0], 'sendAt' | 'useDraft'>;
export type OutboxReceipt = { id: string; fireAt: number; undoSeconds: number; status: string };
export async function enqueueOutbox(
  userId: string,
  key: string,
  undoSeconds: number,
  payload: OutboxPayload,
): Promise<OutboxReceipt> {
  const url = await convexMutation<string>(outbox.uploadUrl, {});
  // Store attachments outside Convex documents' size limit. Buffer.toJSON must
  // not leak into the provider payload; the Nylas SDK accepts base64 content.
  const attachments = payload.attachments?.map((attachment) => ({
    ...attachment,
    content: Buffer.isBuffer(attachment.content) ? attachment.content.toString('base64') : attachment.content,
  }));
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, userId, attachments }),
  });
  if (!response.ok) throw new Error('Could not hold the message. Nothing was sent.');
  const { storageId } = await response.json();
  return convexMutation(outbox.enqueue, { userId, key, undoSeconds, payloadId: storageId });
}
export const cancelOutbox = (userId: string, key: string) =>
  convexMutation<boolean>(outbox.cancel, { userId, key });
export const outboxStatus = (userId: string, key: string) =>
  convexQuery<OutboxReceipt>(outbox.status, { userId, key });
export const claimOutbox = (userId: string, key: string) =>
  convexMutation<{ url: string } | null>(outbox.claim, { userId, key });
export const completeOutbox = (
  userId: string,
  key: string,
  status: 'sent' | 'failed' | 'unknown',
  messageId?: string,
) => convexMutation(outbox.complete, { userId, key, status, messageId });

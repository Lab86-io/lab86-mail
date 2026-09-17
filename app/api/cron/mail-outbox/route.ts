import { type NextRequest, NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { sendNylasMessage } from '@/lib/nylas/provider';
import { claimOutbox, completeOutbox, type OutboxPayload } from '@/lib/send/outbox';
import { writeAudit } from '@/lib/store/audit';
import { upsertMessage } from '@/lib/store/messages';
import { upsertThread } from '@/lib/store/threads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const defaults = {
  fetch,
  writeAudit,
  isInternalCronRequest,
  claimOutbox,
  completeOutbox,
  sendNylasMessage,
  upsertMessage,
  upsertThread,
};
export function createDispatchPost(deps = defaults) {
  return async (req: NextRequest) => {
    if (!deps.isInternalCronRequest(req)) return NextResponse.json({ ok: false }, { status: 401 });
    const { userId, key } = await req.json().catch(() => ({}));
    if (typeof userId !== 'string' || typeof key !== 'string')
      return NextResponse.json({ ok: false }, { status: 400 });
    const claimed = await deps.claimOutbox(userId, key);
    if (!claimed) return NextResponse.json({ ok: true });
    let handedOff = false;
    try {
      const response = await deps.fetch(claimed.url);
      if (!response.ok) throw new Error('Held payload unavailable');
      const payload = (await response.json()) as OutboxPayload;
      if (payload.userId !== userId) throw new Error('Payload owner mismatch');
      const sent = await runWithAiRequestContext({ userId, agent: 'user' }, async () => {
        handedOff = true;
        const message = await deps.sendNylasMessage(payload);
        if (message) {
          await deps.upsertMessage(message).catch(() => undefined);
          await deps
            .upsertThread(message.account, {
              _id: message.threadId || message._id,
              subject: message.subject || '(no subject)',
              fromAddress: message.from,
              lastDate: message.date,
              snippet: message.snippet || '',
              labels: message.labels || [],
              unread: false,
            })
            .catch(() => undefined);
        }
        return message;
      });
      await deps.completeOutbox(userId, key, sent ? 'sent' : 'failed', sent?._id);
      await deps
        .writeAudit({
          tool: 'compose_route:dispatch',
          userId,
          account: payload.account,
          args: { pendingId: key, messageId: sent?._id },
          result: sent ? 'ok' : 'error',
          agent: 'user',
        })
        .catch(() => undefined);
    } catch {
      // A timeout after handoff is uncertain, never permission to send again.
      await deps.completeOutbox(userId, key, handedOff ? 'unknown' : 'failed');
    }
    return NextResponse.json({ ok: true });
  };
}
export const POST = createDispatchPost();

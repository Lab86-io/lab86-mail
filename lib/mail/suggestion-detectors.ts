import { api, convexMutation } from '@/lib/hosted/convex';
import type { NylasAccountRow } from '@/lib/nylas/provider';

const suggestionsApi = (api as any).suggestions;

// Proactive-agent detectors (spec M3): scan freshly ingested mail for things
// worth proposing. Suggestions land in the tray; NOTHING touches the real
// calendar or boards until the user accepts (which runs the normal undoable
// tool path).

interface IngestedMessage {
  providerMessageId: string;
  providerThreadId: string;
  subject: string;
  from: string;
  receivedAt: number;
  attachments?: unknown[];
}

function isIcsAttachment(attachment: any): boolean {
  const type = String(attachment?.contentType || attachment?.content_type || '').toLowerCase();
  const name = String(attachment?.filename || attachment?.name || '').toLowerCase();
  return type.includes('calendar') || name.endsWith('.ics');
}

export function detectMailSuggestions(row: NylasAccountRow, messages: IngestedMessage[]) {
  void (async () => {
    const cutoff = Date.now() - 14 * 86_400_000;
    for (const message of messages) {
      if ((message.receivedAt || 0) < cutoff) continue;
      const ics = (message.attachments || []).find(isIcsAttachment) as any;
      if (!ics) continue;
      const attachmentId = ics.id || ics.attachmentId;
      if (!attachmentId) continue;
      await convexMutation(suggestionsApi.upsert, {
        userId: row.userId,
        kind: 'event',
        title: message.subject || 'Calendar invitation found',
        payload: {
          accountId: row.accountId,
          messageId: message.providerMessageId,
          attachmentId,
          filename: ics.filename || ics.name || 'invite.ics',
          from: message.from,
        },
        provenance: {
          source: 'email',
          accountId: row.accountId,
          threadId: message.providerThreadId,
          messageId: message.providerMessageId,
        },
        dedupeKey: `ics:${row.accountId}:${message.providerMessageId}`,
        // A month-old invite is stale; don't resurrect ancient backfill mail.
        expiresAt: Date.now() + 30 * 86_400_000,
      }).catch(() => undefined);
    }
  })();
}

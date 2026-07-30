import { generateTextForCurrentUser } from '@/lib/ai/gateway';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { dispatchNativeNotification } from '@/lib/notifications/native-delivery';
import type { NylasAccountRow } from '@/lib/nylas/provider';
import { extractOneTimeCode, type OneTimeCodeMessage } from './otp-detect';
import { assessUrgency, parseUrgencyConfirmation, URGENCY_CONFIRMATION_SYSTEM_PROMPT } from './urgency';

const notificationsApi = (api as any).albatrossNotifications;
const oneTimeCodesApi = (api as any).mailOneTimeCodes;

export interface UrgentScanMessage extends OneTimeCodeMessage {
  providerMessageId: string;
  providerThreadId: string;
  to?: string;
  headers?: unknown;
  labels?: string[];
}

interface ScanPreferences {
  nativePushEnabled?: boolean;
  urgentMailPushEnabled?: boolean;
  oneTimeCodeAutofillEnabled?: boolean;
}

// This runs inline with webhook ingest, so a burst must not turn into a burst
// of model calls. Codes and security alerts never need one; only the softer
// urgency signals do, and those are capped per batch.
const MAX_CONFIRMATIONS_PER_BATCH = 3;

// This scan is awaited by the webhook ingest path, so a provider that accepts
// the connection and then stalls would hold up mail sync itself, not just the
// alert. The model only ever adjudicates the softer urgency signals, and an
// alert that arrives late is worthless anyway — so the call is abandoned rather
// than waited on, and a timed-out confirmation simply reads as "not urgent".
const CONFIRMATION_TIMEOUT_MS = 8_000;

async function confirmUrgency(userId: string, message: UrgentScanMessage): Promise<string | null> {
  const source = [message.subject, message.snippet, message.textBody]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 4_000);
  const abort = AbortSignal.timeout(CONFIRMATION_TIMEOUT_MS);
  const { text } = await generateTextForCurrentUser({
    feature: 'mail_urgency',
    speed: 'nano',
    userId,
    maxOutputTokens: 200,
    abortSignal: abort,
    system: URGENCY_CONFIRMATION_SYSTEM_PROMPT,
    prompt: `Received: ${new Date(message.receivedAt).toISOString()}\nFrom: ${message.from}\nTo: ${
      message.to || ''
    }\nEmail:\n${source}`,
  });
  const verdict = parseUrgencyConfirmation(text);
  return verdict.urgent ? verdict.reason : null;
}

/**
 * Scans freshly ingested mail for one-time codes and for messages worth
 * interrupting over. Both outcomes are best-effort: this never blocks or fails
 * mail sync, because a missed alert is recoverable and a stalled corpus is not.
 */
export async function detectUrgentMailAndCodes(row: NylasAccountRow, messages: UrgentScanMessage[]) {
  if (!messages.length) return { codes: 0, urgent: 0 };

  const preference = await convexQuery<ScanPreferences | null>(notificationsApi.mobilePreferences, {
    userId: row.userId,
  }).catch(() => null);
  const pushEnabled = preference?.nativePushEnabled !== false && preference?.urgentMailPushEnabled !== false;
  const codesEnabled = preference?.oneTimeCodeAutofillEnabled !== false;
  if (!pushEnabled && !codesEnabled) return { codes: 0, urgent: 0 };

  let codes = 0;
  let urgent = 0;
  let confirmations = 0;

  for (const message of messages) {
    try {
      const candidate = codesEnabled ? extractOneTimeCode(message) : null;
      let codeRecorded = false;
      if (candidate) {
        const result = await convexMutation<{ created: boolean }>(oneTimeCodesApi.recordCode, {
          userId: row.userId,
          accountId: row.accountId,
          providerMessageId: message.providerMessageId,
          providerThreadId: message.providerThreadId,
          code: candidate.code,
          label: candidate.label,
          issuer: candidate.issuer,
          serviceIdentifiers: candidate.serviceIdentifiers,
          confidence: candidate.confidence,
          receivedAt: message.receivedAt,
          expiresAt: candidate.expiresAt,
        });
        if (result.created) {
          codes += 1;
          codeRecorded = true;
        } else {
          // A duplicate means this message was already handled; re-alerting on
          // a webhook redelivery would fire the same interruption twice.
          continue;
        }
      }

      if (!pushEnabled) continue;
      const assessment = assessUrgency(message, { hasOneTimeCode: Boolean(candidate) });
      if (!assessment.urgent) continue;

      let reason = assessment.reason;
      if (assessment.needsConfirmation) {
        if (confirmations >= MAX_CONFIRMATIONS_PER_BATCH) continue;
        confirmations += 1;
        const confirmed = await confirmUrgency(row.userId, message).catch(() => null);
        if (!confirmed) continue;
        reason = confirmed;
      }

      const queued = await convexMutation<{ notificationId: string; created: boolean }>(
        notificationsApi.queueUrgentMailNotification,
        {
          userId: row.userId,
          accountId: row.accountId,
          threadId: message.providerThreadId,
          messageId: message.providerMessageId,
          sender: message.from,
          subject: message.subject,
          reason,
        },
      );
      if (!queued.created) continue;
      urgent += 1;
      await dispatchNativeNotification(
        row.userId,
        queued.notificationId,
        undefined,
        codeRecorded ? { codeAvailable: true } : {},
      ).catch(() => undefined);
    } catch {
      // Detection is advisory. Mail sync owns the corpus and must complete.
    }
  }
  return { codes, urgent };
}

import { generateTextForCurrentUser } from '@/lib/ai/gateway';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { dispatchNativeNotification } from '@/lib/notifications/native-delivery';
import type { NylasAccountRow } from '@/lib/nylas/provider';

const suggestionsApi = (api as any).suggestions;
const notificationsApi = (api as any).albatrossNotifications;
const DAY_MS = 86_400_000;

// Proactive-agent detectors scan freshly ingested mail for things worth
// proposing. A suggestion and its notification are durable, but the calendar
// is never mutated until the user taps Add.
export interface IngestedMessage {
  providerMessageId: string;
  providerThreadId: string;
  subject: string;
  from: string;
  receivedAt: number;
  snippet?: string;
  textBody?: string;
  attachments?: unknown[];
}

export interface InlineEventCandidate {
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  location?: string;
  reason: string;
  confidence: number;
}

function isIcsAttachment(attachment: any): boolean {
  const type = String(attachment?.contentType || attachment?.content_type || '').toLowerCase();
  const name = String(attachment?.filename || attachment?.name || '').toLowerCase();
  return type.includes('calendar') || name.endsWith('.ics');
}

export function mayContainCalendarEvent(message: IngestedMessage) {
  const text = `${message.subject}\n${message.snippet || ''}\n${message.textBody || ''}`.slice(0, 8_000);
  if (/\b(cancel(?:led|ed|ation)|declined|rescheduled from)\b/i.test(text)) return false;
  const eventSignal =
    /\b(meeting|meet|call|interview|appointment|reservation|booking|flight|train|ticket|demo|conference|webinar|office hours|scheduled)\b/i;
  const dateSignal =
    /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/i;
  return eventSignal.test(text) && dateSignal.test(text);
}

export function parseInlineEventCandidate(raw: string, now = Date.now()): InlineEventCandidate | null {
  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value: any;
  try {
    value = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
  if (value?.isEvent !== true || Number(value?.confidence) < 0.82) return null;
  const title = String(value?.title || '')
    .trim()
    .slice(0, 180);
  const reason = String(value?.reason || '')
    .trim()
    .slice(0, 280);
  const startAt = Date.parse(String(value?.startIso || ''));
  const endAt = Date.parse(String(value?.endIso || ''));
  if (!title || !reason || !Number.isFinite(startAt) || !Number.isFinite(endAt)) return null;
  if (startAt < now - 15 * 60_000 || startAt > now + 370 * DAY_MS) return null;
  if (endAt <= startAt || endAt - startAt > 31 * DAY_MS) return null;
  const location = String(value?.location || '')
    .trim()
    .slice(0, 280);
  return {
    title,
    startAt,
    endAt,
    allDay: value?.allDay === true,
    ...(location ? { location } : {}),
    reason,
    confidence: Number(value.confidence),
  };
}

async function inferInlineEvent(
  userId: string,
  timezone: string,
  message: IngestedMessage,
): Promise<InlineEventCandidate | null> {
  const source = [message.subject, message.snippet, message.textBody]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 8_000);
  const { text } = await generateTextForCurrentUser({
    feature: 'mail_event_suggestion',
    speed: 'nano',
    userId,
    maxOutputTokens: 600,
    system: `You validate whether a newly received email describes one concrete event the recipient would reasonably put on their calendar. Never infer dates or times that are not explicit. Reject newsletters, marketing, vague deadlines, cancellations, past events, and messages that only discuss possibly scheduling. Resolve relative dates from the supplied received time in the supplied IANA timezone. Return only JSON with: isEvent (boolean), confidence (0-1), title, startIso, endIso, allDay, location (string or null), reason. startIso/endIso must include an explicit UTC offset. If duration is absent, use 30 minutes for calls/meetings and one hour for appointments.`,
    prompt: `Received: ${new Date(message.receivedAt).toISOString()}\nTimezone: ${timezone}\nFrom: ${message.from}\nEmail:\n${source}`,
  });
  return parseInlineEventCandidate(text);
}

async function announceSuggestion(input: {
  row: NylasAccountRow;
  message: IngestedMessage;
  suggestionId: string;
  eventTitle: string;
  reason: string;
}) {
  const queued = await convexMutation<{ notificationId: string; created: boolean }>(
    notificationsApi.queueSuggestionNotification,
    {
      userId: input.row.userId,
      suggestionId: input.suggestionId,
      title: `Add “${input.eventTitle}” to your calendar?`,
      body: `${input.message.from || 'An email'}: ${input.reason}`,
      accountId: input.row.accountId,
      threadId: input.message.providerThreadId,
    },
  );
  if (queued.created) {
    await dispatchNativeNotification(input.row.userId, queued.notificationId).catch(() => undefined);
  }
}

export async function detectMailSuggestions(row: NylasAccountRow, messages: IngestedMessage[]) {
  const now = Date.now();
  const timezone = await convexQuery<string>(notificationsApi.deliveryTimezone, { userId: row.userId }).catch(
    () => 'UTC',
  );
  let created = 0;
  for (const message of messages) {
    try {
      if ((message.receivedAt || 0) < now - 14 * DAY_MS) continue;
      const ics = (message.attachments || []).find(isIcsAttachment) as any;
      if (ics) {
        const attachmentId = ics.id || ics.attachmentId;
        if (!attachmentId) continue;
        const dedupeKey = `ics:${row.accountId}:${message.providerMessageId}`;
        const existing = await convexQuery<any>(suggestionsApi.getByDedupe, {
          userId: row.userId,
          dedupeKey,
        });
        if (existing) continue;
        const suggestionId = await convexMutation<string>(suggestionsApi.upsert, {
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
          dedupeKey,
          expiresAt: now + 30 * DAY_MS,
        });
        await announceSuggestion({
          row,
          message,
          suggestionId,
          eventTitle: message.subject || 'calendar invitation',
          reason: 'This email includes a calendar invitation.',
        });
        created += 1;
        continue;
      }

      // Inline extraction is intentionally limited to very recent mail and a
      // strong lexical prefilter. The model validates, but it never gets to
      // mutate the calendar and it cannot turn vague prose into a date.
      if (message.receivedAt < now - 2 * DAY_MS || !mayContainCalendarEvent(message)) continue;
      const dedupeKey = `inline-event:${row.accountId}:${message.providerMessageId}`;
      const existing = await convexQuery<any>(suggestionsApi.getByDedupe, { userId: row.userId, dedupeKey });
      if (existing) continue;
      const candidate = await inferInlineEvent(row.userId, timezone, message).catch(() => null);
      if (!candidate) continue;
      const suggestionId = await convexMutation<string>(suggestionsApi.upsert, {
        userId: row.userId,
        kind: 'event',
        title: candidate.title,
        payload: {
          accountId: row.accountId,
          messageId: message.providerMessageId,
          from: message.from,
          event: candidate,
        },
        provenance: {
          source: 'email',
          accountId: row.accountId,
          threadId: message.providerThreadId,
          messageId: message.providerMessageId,
        },
        dedupeKey,
        expiresAt: Math.min(candidate.endAt + 7 * DAY_MS, now + 60 * DAY_MS),
      });
      await announceSuggestion({
        row,
        message,
        suggestionId,
        eventTitle: candidate.title,
        reason: candidate.reason,
      });
      created += 1;
    } catch {
      // Suggestion generation is best-effort and must never block mail sync.
    }
  }
  return { created };
}

import { api, convexMutation } from '../hosted/convex';
import { dispatchNativeNotification } from '../notifications/native-delivery';

export function localDateForTimezone(generatedAt: number, timezone?: string) {
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(new Date(generatedAt))
    .reduce<Record<string, string>>((parts, part) => {
      if (part.type !== 'literal') parts[part.type] = part.value;
      return parts;
    }, {});
  return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
}

// The push body: the first sentences of the lede, cut at a sentence end when
// one fits inside the limit. Empty when the edition has no prose, so the
// notification keeps its fixed line.
export const BRIEF_NOTIFICATION_BODY_MAX = 180;
export function briefNotificationBody(report: { prose?: { lede?: string }; narrative?: string }): string {
  const text = String(report?.prose?.lede || report?.narrative || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= BRIEF_NOTIFICATION_BODY_MAX) return text;
  const head = text.slice(0, BRIEF_NOTIFICATION_BODY_MAX);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  if (end > 40) return head.slice(0, end + 1);
  return `${head.slice(0, BRIEF_NOTIFICATION_BODY_MAX - 1).trimEnd()}…`;
}

const defaults = {
  queueBriefReady: (input: { userId: string; reportId: string; localDate: string; body?: string }) =>
    convexMutation<any>((api as any).albatrossNotifications.queueBriefReady, input),
  dispatchNativeNotification,
};
export async function notifyBriefReady(
  userId: string,
  kind: string,
  report: { _id: string; generatedAt: number; prose?: { lede?: string }; narrative?: string },
  timezone?: string,
  deps = defaults,
) {
  if (kind !== 'morning') return;
  try {
    const queued = await deps.queueBriefReady({
      userId,
      reportId: report._id,
      localDate: localDateForTimezone(report.generatedAt, timezone),
      body: briefNotificationBody(report) || undefined,
    });
    return queued?.notificationId
      ? await deps.dispatchNativeNotification(userId, String(queued.notificationId))
      : { skipped: queued?.skipped || 'not_queued' };
  } catch {
    console.error('[brief jobs] brief-ready notification failed', userId);
    return { failed: true };
  }
}

import { emailFromHeader } from '../shared/format';

// Quiet hours, VIP senders, and priority-only mail push (FEATURES item 12).
//
// - Quiet hours: nothing pushes between the start and end hour in the user's
//   zone, except mail from a VIP sender. Held mail goes out in one digest when
//   quiet hours end.
// - Priority only: push only VIP senders, urgent mail, and mail that needs a
//   reply or an action (Jev obligations). The rest waits for a digest, at most
//   one each hour.
// Pure: the ingest scan (lib/mail/urgent-detectors) and the digest cron use it.

export type MailPushMode = 'all' | 'priority';
export type MailPushHoldReason = 'quiet_hours' | 'priority_only';

export interface MailPushSettings {
  mode: MailPushMode;
  quietHours: { enabled: boolean; start: number; end: number };
  vipSenders: string[];
  timezone: string;
}

export const DEFAULT_MAIL_PUSH_SETTINGS: MailPushSettings = {
  mode: 'all',
  quietHours: { enabled: false, start: 22, end: 7 },
  vipSenders: [],
  timezone: 'UTC',
};

export const DIGEST_INTERVAL_MS = 60 * 60_000;
export const VIP_SENDER_LIMIT = 200;

/** A VIP entry is an address (ann@example.com) or a domain (@example.com or example.com). */
export function normalizeVipSender(value: string): string | null {
  const raw = value.trim().toLowerCase();
  if (!raw || raw.length > 254) return null;
  const email = emailFromHeader(raw);
  if (email && !raw.startsWith('@')) return email;
  const domain = raw.replace(/^@/, '');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return `@${domain}`;
  return null;
}

export function normalizeVipSenders(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const value of values) {
    const entry = typeof value === 'string' ? normalizeVipSender(value) : null;
    if (entry && !out.includes(entry)) out.push(entry);
    if (out.length >= VIP_SENDER_LIMIT) break;
  }
  return out;
}

export function isVipSender(from: string | null | undefined, vipSenders: string[]): boolean {
  const email = emailFromHeader(from);
  if (!email || !vipSenders.length) return false;
  const domain = email.split('@')[1] || '';
  return vipSenders.some((entry) =>
    entry.startsWith('@')
      ? domain === entry.slice(1) || domain.endsWith(`.${entry.slice(1)}`)
      : entry === email,
  );
}

function localHourMinute(now: number, timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date(now));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
    return { hour: get('hour') % 24, minute: get('minute') };
  } catch {
    const date = new Date(now);
    return { hour: date.getUTCHours(), minute: date.getUTCMinutes() };
  }
}

/** True inside [start, end) in the user's zone. The window may cross midnight. */
export function inQuietHours(now: number, settings: Pick<MailPushSettings, 'quietHours' | 'timezone'>) {
  const { enabled, start, end } = settings.quietHours;
  if (!enabled || start === end) return false;
  const { hour } = localHourMinute(now, settings.timezone);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** When the current quiet hours end, or `now` when not in quiet hours. */
export function quietHoursEndAt(now: number, settings: Pick<MailPushSettings, 'quietHours' | 'timezone'>) {
  if (!inQuietHours(now, settings)) return now;
  const { hour, minute } = localHourMinute(now, settings.timezone);
  const end = settings.quietHours.end;
  const hoursLeft = (end - hour + 24) % 24 || 24;
  return now + hoursLeft * 60 * 60_000 - minute * 60_000 - (now % 60_000);
}

export type MailPushDecision =
  | { action: 'push'; reason: 'vip' | 'priority' | 'all' }
  | { action: 'hold'; reason: MailPushHoldReason; until: number };

/**
 * Push now, or hold for the digest. VIP mail always pushes. Quiet hours hold
 * everything else until they end. Priority-only mode holds mail that is not
 * urgent and needs no reply or action, for up to one hour.
 */
export function decideMailPush(input: {
  now: number;
  settings: MailPushSettings;
  from: string | null | undefined;
  /** Urgent mail, or a message that needs a reply or an action. */
  priority: boolean;
}): MailPushDecision {
  if (isVipSender(input.from, input.settings.vipSenders)) return { action: 'push', reason: 'vip' };
  if (inQuietHours(input.now, input.settings)) {
    return { action: 'hold', reason: 'quiet_hours', until: quietHoursEndAt(input.now, input.settings) };
  }
  if (input.settings.mode === 'priority') {
    if (input.priority) return { action: 'push', reason: 'priority' };
    return { action: 'hold', reason: 'priority_only', until: input.now + DIGEST_INTERVAL_MS };
  }
  return { action: 'push', reason: 'all' };
}

/** The digest push text: "5 new emails" and who they are from. */
export function digestCopy(senders: string[], count: number) {
  const names = [...new Set(senders.map((sender) => sender.trim()).filter(Boolean))];
  const title = `${count} new ${count === 1 ? 'email' : 'emails'}`;
  if (!names.length) return { title, body: 'Open Mail to read them.' };
  const shown = names.slice(0, 2);
  const others = names.length - shown.length;
  const body =
    others > 0
      ? `From ${shown.join(', ')}, and ${others} ${others === 1 ? 'other' : 'others'}`
      : `From ${shown.join(' and ')}`;
  return { title, body };
}

/** Reads the stored preference fields into settings with defaults. */
export function mailPushSettingsFromRow(row: Record<string, any> | null | undefined): MailPushSettings {
  const hour = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23 ? value : fallback;
  return {
    mode: row?.mailPushMode === 'priority' ? 'priority' : 'all',
    quietHours: {
      enabled: row?.quietHoursEnabled === true,
      start: hour(row?.quietHoursStart, DEFAULT_MAIL_PUSH_SETTINGS.quietHours.start),
      end: hour(row?.quietHoursEnd, DEFAULT_MAIL_PUSH_SETTINGS.quietHours.end),
    },
    vipSenders: normalizeVipSenders(row?.vipSenders),
    timezone: typeof row?.timezone === 'string' && row.timezone ? row.timezone : 'UTC',
  };
}

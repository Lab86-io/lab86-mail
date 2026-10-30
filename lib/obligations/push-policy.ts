// Needs you delivery rules (docs/needs-you.md, "Delivery rules"). Pure: the
// Convex claim (convex/obligations.ts) decides inside its transaction, so two
// pushes at the same time cannot both take the last slot of the hour.
//
// - One push for each obligation. The obligation id is the APNs collapse id.
// - A code pushes at once. Quiet hours and the hourly limit never hold it.
// - Quiet hours hold a push until they end, except a time-sensitive item and
//   an item from a VIP sender.
// - At most PUSH_HOURLY_LIMIT pushes each hour, codes not included. An item
//   over the limit stays in-app; at most one summary push each hour says
//   "N more things need you".

import {
  inQuietHours,
  isVipSender,
  type MailPushSettings,
  mailPushSettingsFromRow,
  quietHoursEndAt,
} from '../notifications/mail-push';
import { type ObligationKind, type ObligationState, PUSH_HOURLY_LIMIT, type PushLevel } from './contract';

export const PUSH_WINDOW_MS = 60 * 60_000;

export interface ObligationPushSettings extends MailPushSettings {
  nativePushEnabled: boolean;
  /** "Push me when something needs me". Codes do not read it. */
  obligationPushEnabled: boolean;
  /** "Verification codes" (oneTimeCodeAutofillEnabled). */
  codesEnabled: boolean;
}

/** Reads the preference row with defaults: every switch is on. */
export function obligationPushSettingsFromRow(
  row: Record<string, any> | null | undefined,
): ObligationPushSettings {
  return {
    ...mailPushSettingsFromRow(row),
    nativePushEnabled: row?.nativePushEnabled !== false,
    obligationPushEnabled: row?.obligationPushEnabled !== false,
    codesEnabled: row?.oneTimeCodeAutofillEnabled !== false,
  };
}

export interface PushCandidate {
  kind: ObligationKind;
  state: ObligationState;
  pushLevel: PushLevel;
  askerAddress?: string;
}

export type ObligationPushDecision =
  | { action: 'push'; timeSensitive: boolean; codeAvailable: boolean }
  | { action: 'hold'; reason: 'quiet_hours' | 'limit'; until: number }
  | { action: 'none'; reason: 'closed' | 'in_app_only' | 'disabled' };

/** The pushes in the window, codes not included: the times of their last push. */
export function pushesInWindow(pushedAt: number[], now: number) {
  return pushedAt.filter((at) => at > now - PUSH_WINDOW_MS && at <= now);
}

/** When the next summary may go: one hour after the last one. */
function limitHoldUntil(window: number[], now: number, lastSummaryAt?: number) {
  const slot = window.length ? Math.min(...window) + PUSH_WINDOW_MS : now;
  return Math.max(slot, (lastSummaryAt ?? 0) + PUSH_WINDOW_MS, now + 60_000);
}

/** Push now, hold, or stay in-app. */
export function decideObligationPush(input: {
  obligation: PushCandidate;
  settings: ObligationPushSettings;
  now: number;
  /** The last push time of each obligation pushed in the last hour, codes not included. */
  recentPushes: number[];
  lastSummaryAt?: number;
}): ObligationPushDecision {
  const { obligation, settings, now } = input;
  if (obligation.state !== 'open') return { action: 'none', reason: 'closed' };
  if (obligation.pushLevel === 'none') return { action: 'none', reason: 'in_app_only' };
  if (!settings.nativePushEnabled) return { action: 'none', reason: 'disabled' };
  if (obligation.kind === 'code') {
    if (!settings.codesEnabled) return { action: 'none', reason: 'disabled' };
    return { action: 'push', timeSensitive: true, codeAvailable: true };
  }
  if (!settings.obligationPushEnabled) return { action: 'none', reason: 'disabled' };
  const timeSensitive = obligation.pushLevel === 'time_sensitive';
  const vip = isVipSender(obligation.askerAddress, settings.vipSenders);
  if (!timeSensitive && !vip && inQuietHours(now, settings))
    return { action: 'hold', reason: 'quiet_hours', until: quietHoursEndAt(now, settings) };
  const window = pushesInWindow(input.recentPushes, now);
  if (window.length >= PUSH_HOURLY_LIMIT)
    return { action: 'hold', reason: 'limit', until: limitHoldUntil(window, now, input.lastSummaryAt) };
  return { action: 'push', timeSensitive, codeAvailable: false };
}

/** The summary push: "3 more things need you." */
export function summaryCopy(count: number, more: boolean) {
  const things = count === 1 ? 'thing needs' : 'things need';
  return { title: 'Needs you', body: `${count} ${more ? 'more ' : ''}${things} you.` };
}

export interface HeldPush {
  id: string;
  reason: 'quiet_hours' | 'limit';
}

export type ReleasePlan =
  | { action: 'wait' }
  | { action: 'single'; id: string }
  | { action: 'summary'; ids: string[]; title: string; body: string }
  | { action: 'later'; until: number };

/**
 * What to do with the held pushes of one user that are due. One item held by
 * quiet hours pushes as itself when the hour has room. More items, or items
 * over the limit, become one summary push, at most one each hour.
 */
export function releasePlan(input: {
  due: HeldPush[];
  settings: ObligationPushSettings;
  now: number;
  recentPushes: number[];
  lastSummaryAt?: number;
}): ReleasePlan {
  const { due, settings, now } = input;
  if (!due.length || inQuietHours(now, settings)) return { action: 'wait' };
  const window = pushesInWindow(input.recentPushes, now);
  const overLimit = due.some((item) => item.reason === 'limit');
  if (due.length === 1 && !overLimit && window.length < PUSH_HOURLY_LIMIT)
    return { action: 'single', id: due[0].id };
  if (input.lastSummaryAt !== undefined && input.lastSummaryAt > now - PUSH_WINDOW_MS)
    return { action: 'later', until: input.lastSummaryAt + PUSH_WINDOW_MS };
  return { action: 'summary', ids: due.map((item) => item.id), ...summaryCopy(due.length, overLimit) };
}

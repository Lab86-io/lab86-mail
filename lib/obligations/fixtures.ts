// Needs you fixtures for the preview and the tests. Every person, company,
// and address is invented. Domains are example.com.

import { horizonClock } from '@/lib/albatross/horizon';
import type { ObligationDraftResponse, ObligationView } from './contract';
import { mailSourceKey } from './contract';
import type { NeedsYouExtraLike } from './groups';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Wednesday, October 28, 2026, 11:05 AM in Los Angeles. */
export const NEEDS_YOU_FIXTURE_NOW = Date.UTC(2026, 9, 28, 18, 5, 0);
export const NEEDS_YOU_FIXTURE_TIMEZONE = 'America/Los_Angeles';

/** An Albatross question, approval, or check-in as the Notifications model projects it. */
export interface NeedsYouExtraFixture extends NeedsYouExtraLike {
  title: string;
  body: string;
  context: string;
  source: string;
  unread: boolean;
  notificationIds: string[];
  unreadNotificationIds: string[];
  action:
    | { kind: 'work'; workId: string; areaId?: string }
    | { kind: 'checkin'; checkinId: string }
    | { kind: 'albatrosses' };
  actionLabel: string;
}

export interface NeedsYouFixture {
  timezone: string;
  items: ObligationView[];
  extras: NeedsYouExtraFixture[];
  drafts: Record<string, ObligationDraftResponse['draft']>;
}

const ACCOUNT = 'acct_alex';

function obligation(
  id: string,
  threadId: string,
  fields: Omit<ObligationView, 'id' | 'source' | 'sourceKey' | 'accountId' | 'threadId' | 'updatedAt'> &
    Partial<Pick<ObligationView, 'updatedAt'>>,
): ObligationView {
  return {
    id,
    source: 'mail',
    sourceKey: mailSourceKey(ACCOUNT, threadId),
    accountId: ACCOUNT,
    threadId,
    updatedAt: fields.updatedAt ?? fields.createdAt,
    ...fields,
  };
}

/** The page with every group filled, at `now` in `timezone`. */
export function needsYouFixture(
  now = NEEDS_YOU_FIXTURE_NOW,
  timezone = NEEDS_YOU_FIXTURE_TIMEZONE,
): NeedsYouFixture {
  const clock = horizonClock(timezone);
  const today = clock.today(now);
  const at = (dayOffset: number, hour: number, minute = 0) =>
    clock.midnight(today.year, today.month, today.day + dayOffset) + hour * HOUR_MS + minute * MINUTE_MS;
  const daysToFriday = (5 - today.weekday + 7) % 7 || 7;
  const daysToMonday = (1 - today.weekday + 7) % 7 || 7;

  const items: ObligationView[] = [
    obligation('ob_code_now', 'thr_bank_code_2', {
      kind: 'code',
      state: 'open',
      title: 'Verification code from Northwind Bank.',
      asker: 'Northwind Bank',
      askerAddress: 'no-reply@northwindbank.example.com',
      excerpt:
        'Your Northwind Bank sign-in code is 482 913. It expires in 10 minutes. If you did not ask for a code, ignore this message.',
      due: 'today',
      pushLevel: 'time_sensitive',
      probability: 0.99,
      code: { value: '482913', issuer: 'Northwind Bank', expiresAt: now + 8 * MINUTE_MS },
      createdAt: now - 2 * MINUTE_MS,
    }),
    obligation('ob_flight', 'thr_harbor_air', {
      kind: 'change',
      state: 'open',
      title: 'Flight HA 220 now departs at 6:40 PM, not 3:15 PM.',
      asker: 'Harbor Air',
      askerAddress: 'reservations@harborair.example.com',
      why: 'The departure moved from 3:15 PM to 6:40 PM today. Your calendar still has the earlier time, with a car to the airport at 1:30 PM.',
      excerpt:
        'Your flight HA 220 from Portland (PDX) to Denver (DEN) now departs at 6:40 PM and arrives at 10:05 PM. Seat 14C is unchanged. No action is needed to keep your booking.',
      due: 'today',
      dueAt: at(0, 18, 40),
      pushLevel: 'time_sensitive',
      probability: 0.93,
      createdAt: at(0, 9, 12),
    }),
    obligation('ob_review', 'thr_sam_review', {
      kind: 'action',
      state: 'open',
      title: 'Asks for your review of the ledger migration before today’s release.',
      asker: 'Sam Okafor',
      askerAddress: 'sam@northwind.example.com',
      why: 'Sam named you as the reviewer and the release is today at 5 PM.',
      excerpt:
        'Could you review the ledger migration today? The release train leaves at 5 and this is the last change in it.',
      due: 'today',
      pushLevel: 'normal',
      probability: 0.88,
      createdAt: at(0, 8, 5),
    }),
    obligation('ob_sow', 'thr_dana_sow', {
      kind: 'reply',
      state: 'open',
      title: 'Asks you to confirm the revised start date in the SOW by Friday.',
      asker: 'Dana Whitfield',
      askerAddress: 'dana@northwindlegal.example.com',
      why: 'Dana asked you a direct question and named Friday. The thread has no reply from you yet.',
      excerpt:
        'Hi Alex, after the kickoff slipped we moved the start date in the SOW to Monday, November 16. Can you confirm by Friday so our side can countersign?\n\nThanks, Dana',
      due: 'soon',
      dueAt: at(daysToFriday, 17),
      pushLevel: 'normal',
      probability: 0.91,
      createdAt: at(-1, 16, 48),
    }),
    obligation('ob_nda', 'thr_lena_nda', {
      kind: 'action',
      state: 'open',
      title: 'Asks for the signed NDA for Harbor Labs before Monday.',
      asker: 'Lena Fischer',
      askerAddress: 'lena@harborlabs.example.com',
      why: 'Lena attached the NDA and asked for a signed copy before the Monday kickoff.',
      excerpt: 'Attached is the NDA with the changes we agreed. Can you sign and return it before Monday?',
      due: 'soon',
      dueAt: at(daysToMonday, 9),
      pushLevel: 'none',
      probability: 0.84,
      createdAt: at(0, 7, 50),
    }),
    obligation('ob_dentist', 'thr_oakridge', {
      kind: 'action',
      state: 'open',
      title: 'Asks you to confirm the appointment on November 12.',
      asker: 'Oakridge Dental',
      askerAddress: 'appointments@oakridgedental.example.com',
      why: 'The office asks for a confirmation three days before the visit.',
      excerpt: 'Your cleaning is on Thursday, November 12 at 2:30 PM. Reply CONFIRM or call us to change it.',
      due: 'later',
      dueAt: Date.UTC(2026, 10, 9, 17, 0),
      pushLevel: 'none',
      probability: 0.8,
      createdAt: at(-2, 10, 20),
    }),
    obligation('ob_panel', 'thr_jonas_panel', {
      kind: 'reply',
      state: 'open',
      title: 'Asks if you want to join the panel at the Portland meetup.',
      asker: 'Jonas Lindqvist',
      askerAddress: 'jonas@meetup.example.com',
      why: 'Jonas asked you directly. He did not name a date.',
      excerpt: 'We are putting together a panel on small teams for the next Portland meetup. Would you join?',
      due: 'none',
      pushLevel: 'none',
      probability: 0.79,
      createdAt: at(-1, 9, 15),
    }),
    obligation('ob_lease', 'thr_marco_lease', {
      kind: 'waiting',
      state: 'open',
      title: 'You wait for Marco Ruiz to send the signed lease.',
      asker: 'Marco Ruiz',
      askerAddress: 'marco@pinestreet.example.com',
      why: 'You asked Marco for the signed lease six days ago. There is no reply.',
      excerpt:
        'Hi Marco, attached is the lease for the Pine Street office with the changes we agreed. Please sign it and send it back when you can.',
      due: 'none',
      pushLevel: 'none',
      probability: 0.86,
      createdAt: now - 6 * DAY_MS,
    }),
    obligation('ob_kickoff', 'thr_tomas_kickoff', {
      kind: 'reply',
      state: 'done',
      title: 'Asked for the Q4 kickoff date.',
      asker: 'Tomas Berg',
      askerAddress: 'tomas@northwind.example.com',
      due: 'today',
      pushLevel: 'normal',
      probability: 0.9,
      createdAt: at(-1, 15, 10),
      closedAt: at(0, 8, 31),
      closeReason: 'sent_reply',
    }),
    obligation('ob_code_used', 'thr_bank_code_1', {
      kind: 'code',
      state: 'done',
      title: 'Verification code from Northwind Bank.',
      asker: 'Northwind Bank',
      askerAddress: 'no-reply@northwindbank.example.com',
      due: 'today',
      pushLevel: 'time_sensitive',
      probability: 0.99,
      code: { value: '117 204', issuer: 'Northwind Bank', expiresAt: at(0, 8, 8) },
      createdAt: at(0, 7, 58),
      closedAt: at(0, 7, 59),
      closeReason: 'code_used',
    }),
    obligation('ob_invoice', 'thr_harbor_invoice', {
      kind: 'action',
      state: 'resolved',
      title: 'Asked you to approve the October invoice.',
      asker: 'Harbor Labs',
      askerAddress: 'billing@harborlabs.example.com',
      due: 'soon',
      pushLevel: 'none',
      probability: 0.82,
      createdAt: at(-1, 11, 0),
      closedAt: at(0, 9, 48),
      closeReason: 'evidence',
    }),
    obligation('ob_numbers', 'thr_priya_numbers', {
      kind: 'reply',
      state: 'done',
      title: 'Asked for the Q3 numbers before the review.',
      asker: 'Priya Raman',
      askerAddress: 'priya@northwind.example.com',
      due: 'soon',
      pushLevel: 'normal',
      probability: 0.87,
      createdAt: at(-1, 10, 2),
      closedAt: at(0, 10, 12),
      closeReason: 'user_done_no_reply',
    }),
  ];

  const extras: NeedsYouExtraFixture[] = [
    {
      id: 'question:q_deck',
      kind: 'question',
      title: 'Which quarter numbers should the deck use? The run waits for your answer.',
      body: 'Finance signed off on revenue this morning. Pipeline and churn still have two versions.',
      context: 'Q3 review deck',
      source: 'Question',
      createdAt: at(0, 10, 40),
      attention: true,
      unread: false,
      notificationIds: [],
      unreadNotificationIds: [],
      action: { kind: 'work', workId: 'work_q3_deck' },
      actionLabel: 'Answer in Albatross',
    },
    {
      id: 'checkin:today',
      kind: 'checkin',
      title: 'Close the loop on your day',
      body: 'What moved today? What would you like to do tomorrow?',
      context: '2026-10-28',
      source: 'Daily check-in',
      createdAt: at(0, 7, 0),
      attention: true,
      unread: false,
      notificationIds: [],
      unreadNotificationIds: [],
      action: { kind: 'checkin', checkinId: 'checkin_today' },
      actionLabel: 'Check in',
    },
  ];

  const drafts: NeedsYouFixture['drafts'] = {
    ob_sow: {
      to: ['dana@northwindlegal.example.com'],
      cc: [],
      subject: 'Re: SOW start date',
      body: 'Hi Dana,\n\nNovember 16 works on our side. Please go ahead with the countersignature and send the signed copy when it is ready.\n\nThanks,\nAlex',
    },
    ob_panel: {
      to: ['jonas@meetup.example.com'],
      cc: [],
      subject: 'Re: Panel at the Portland meetup',
      body: 'Hi Jonas,\n\nThank you for the invitation. Which date do you have in mind? I can say yes once I see it against my calendar.\n\nAlex',
    },
  };

  return { timezone, items, extras, drafts };
}

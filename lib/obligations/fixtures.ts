// Needs you fixtures for the preview and the tests. Every person, company,
// and address is invented. Domains are example.com.

import { horizonClock } from '@/lib/albatross/horizon';
import type { BriefDocumentV2, BriefRegion } from '@/lib/shared/brief-document';
import { letterBriefDocumentFixture } from '@/lib/shared/brief-document-fixtures';
import type { ObligationDraftResponse, ObligationView } from './contract';
import { mailSourceKey } from './contract';
import type { NeedsYouExtraLike } from './groups';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Wednesday, October 28, 2026, 11:05 AM in Los Angeles. */
export const NEEDS_YOU_FIXTURE_NOW = Date.UTC(2026, 9, 28, 18, 5, 0);
export const NEEDS_YOU_FIXTURE_TIMEZONE = 'America/Los_Angeles';

/** The Albatross that the Slack, Granola, and calendar items belong to. */
export const NEEDS_YOU_FIXTURE_WORK_ID = 'work_q3_deck';
export const NEEDS_YOU_FIXTURE_WORK_TITLE = 'Q3 review deck';

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

type Fields<K extends keyof ObligationView> = Omit<ObligationView, 'id' | 'updatedAt' | K> &
  Partial<Pick<ObligationView, 'updatedAt'>>;

function obligation(
  id: string,
  threadId: string,
  fields: Fields<'source' | 'sourceKey' | 'accountId' | 'threadId'>,
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

/** An item from a connected source or the calendar. */
function item(id: string, fields: Fields<never>): ObligationView {
  return { id, updatedAt: fields.updatedAt ?? fields.createdAt, ...fields };
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
      sourceLabel: 'Northwind Legal',
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
    // Phase 1.1: a time-sensitive change older than CHANGE_NOW_WINDOW_MS sits in Today, not Now.
    obligation('ob_card', 'thr_harbor_card', {
      kind: 'change',
      state: 'open',
      title: 'Your card payment of $240 to Northwind Cloud failed.',
      asker: 'Harbor Card',
      askerAddress: 'alerts@harborcard.example.com',
      why: 'The payment failed three days ago. Northwind Cloud pauses the service after seven days.',
      excerpt:
        'We could not charge your card ending 4412 for the October invoice. Update the card to keep the service.',
      due: 'today',
      pushLevel: 'time_sensitive',
      probability: 0.9,
      createdAt: at(-3, 8, 15),
    }),
    // Phase 2: the connected sources.
    item('ob_slack_numbers', {
      kind: 'action',
      state: 'open',
      source: 'slack',
      sourceKey: 'slack:T01:C_RELEASE:1730131320',
      sourceLabel: '#release',
      url: 'https://northwind.example.com/slack/archives/C_RELEASE/p1730131320',
      title: 'Asks for the Q3 numbers before the Friday review.',
      asker: 'Priya Raman',
      why: 'Priya named you and asked for the numbers. The review is on Friday at 3 PM. This belongs to the Albatross Q3 review deck.',
      excerpt:
        '@alex can you drop the Q3 numbers into the deck before Friday’s review? Finance signed off on revenue this morning. We still need the pipeline and churn figures.',
      due: 'soon',
      dueAt: at(daysToFriday, 15),
      workId: NEEDS_YOU_FIXTURE_WORK_ID,
      workTitle: NEEDS_YOU_FIXTURE_WORK_TITLE,
      pushLevel: 'normal',
      probability: 0.9,
      createdAt: at(0, 10, 2),
    }),
    item('ob_jira_lab212', {
      kind: 'action',
      state: 'open',
      source: 'atlassian',
      sourceKey: 'atlassian:northwind:LAB-212',
      sourceLabel: 'LAB-212',
      url: 'https://northwind.example.com/jira/browse/LAB-212',
      title: 'Assigned you LAB-212, Rotate the staging credentials, due tomorrow.',
      asker: 'Tomas Berg',
      why: 'Tomas assigned the issue to you and set the due date to tomorrow.',
      excerpt:
        'Rotate the staging credentials before the audit. The old keys are in the vault under staging-2025.',
      due: 'soon',
      dueAt: at(1, 17),
      pushLevel: 'none',
      probability: 0.86,
      createdAt: at(0, 8, 40),
    }),
    item('ob_granola_nda', {
      kind: 'action',
      state: 'open',
      source: 'granola',
      sourceKey: 'granola:meeting:vendor-sync-1027',
      sourceLabel: 'Vendor sync',
      url: 'https://notes.example.com/d/vendor-sync-1027',
      title: 'You said you would send the signed NDA to Harbor Labs today.',
      asker: 'Vendor sync',
      why: 'In the meeting you said you would send the NDA today. Lena waits for it.',
      excerpt:
        'Alex: I will send the signed NDA over today so you can start Monday.\nLena: Great, thank you.',
      due: 'today',
      workId: 'work_harbor_nda',
      workTitle: 'Harbor Labs NDA',
      pushLevel: 'normal',
      probability: 0.84,
      createdAt: at(-1, 15, 30),
    }),
    item('ob_github_491', {
      kind: 'action',
      state: 'open',
      source: 'github',
      sourceKey: 'github:northwind/web:pull:491',
      sourceLabel: 'northwind/web #491',
      url: 'https://github.example.com/northwind/web/pull/491',
      title: 'Asked for your review on northwind/web #491, Fix the ledger rounding, before today’s release.',
      asker: 'Maya Chen',
      why: 'Maya requested your review. The release train leaves at 5 PM.',
      excerpt: 'Fix the ledger rounding. 14 files changed. Ready for review.',
      due: 'today',
      dueAt: at(0, 17),
      pushLevel: 'normal',
      probability: 0.9,
      createdAt: at(0, 8, 5),
    }),
    item('ob_pipeline', {
      kind: 'change',
      state: 'open',
      source: 'bitbucket',
      sourceKey: 'bitbucket:northwind/ledger:pipeline:1842',
      sourceLabel: 'feature/ledger-sync',
      url: 'https://bitbucket.example.com/northwind/ledger/pipelines/1842',
      title: 'The pipeline on feature/ledger-sync failed on the test step.',
      asker: 'Bitbucket Pipelines',
      why: 'The failed check is on your branch, and the release is today.',
      excerpt: 'Pipeline #1842 failed: 2 tests in ledger/sync.test.ts.',
      due: 'today',
      pushLevel: 'normal',
      probability: 0.88,
      createdAt: at(0, 9, 48),
    }),
    item('ob_drive_memo', {
      kind: 'reply',
      state: 'open',
      source: 'drive',
      sourceKey: 'drive:file:1a2b3c:comment:77',
      sourceLabel: 'Q3 board memo',
      url: 'https://docs.example.com/document/d/1a2b3c/edit?disco=77',
      title: 'Asks you to answer her comment on the Q3 board memo.',
      asker: 'Noor Haddad',
      why: 'Noor assigned the comment to you and asked for an answer this week.',
      excerpt: 'Can you confirm the headcount number in section 2? +Alex',
      due: 'soon',
      pushLevel: 'none',
      probability: 0.8,
      createdAt: at(-1, 13, 5),
    }),
    // Phase 4: the calendar.
    item('ob_rsvp', {
      kind: 'rsvp',
      state: 'open',
      source: 'calendar',
      sourceKey: `calendar:${ACCOUNT}:evt_harbor_followup`,
      sourceLabel: 'Harbor Labs follow-up',
      url: 'https://calendar.example.com/event/evt_harbor_followup',
      accountId: ACCOUNT,
      eventId: 'evt_harbor_followup',
      eventStart: at(1, 15),
      title: 'Invites you to Harbor Labs follow-up, tomorrow at 3 PM.',
      asker: 'Mira Sato',
      askerAddress: 'mira@harborlabs.example.com',
      why: 'The invitation waits for your answer. The meeting is tomorrow.',
      excerpt: 'Mira Sato, Lena Fischer, and you. Pine Street office, room 2.',
      due: 'soon',
      dueAt: at(1, 15),
      pushLevel: 'none',
      probability: 0.95,
      createdAt: at(-1, 17, 20),
    }),
    item('ob_prepare', {
      kind: 'prepare',
      state: 'open',
      source: 'calendar',
      sourceKey: `calendar:${ACCOUNT}:evt_board_checkin`,
      sourceLabel: 'Board check-in',
      url: 'https://calendar.example.com/event/evt_board_checkin',
      accountId: ACCOUNT,
      eventId: 'evt_board_checkin',
      eventStart: at(1, 9),
      title: 'Bring the Q3 numbers to the board check-in tomorrow at 9 AM.',
      asker: 'Board check-in',
      why: 'The agenda asks each lead for the quarter numbers. The deck is still at step 2.',
      excerpt: 'Rafael Costa, Priya Raman, Noor Haddad, and you. Agenda: Q3 numbers by lead, hiring plan.',
      due: 'today',
      workId: NEEDS_YOU_FIXTURE_WORK_ID,
      workTitle: NEEDS_YOU_FIXTURE_WORK_TITLE,
      pushLevel: 'normal',
      probability: 0.82,
      createdAt: at(0, 9, 0),
    }),
    // Closed today.
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
      workId: NEEDS_YOU_FIXTURE_WORK_ID,
      workTitle: NEEDS_YOU_FIXTURE_WORK_TITLE,
      pushLevel: 'normal',
      probability: 0.87,
      createdAt: at(-1, 10, 2),
      closedAt: at(0, 10, 12),
      closeReason: 'user_done_no_reply',
    }),
    item('ob_pipeline_passed', {
      kind: 'change',
      state: 'resolved',
      source: 'bitbucket',
      sourceKey: 'bitbucket:northwind/ledger:pipeline:1839',
      sourceLabel: 'feature/ledger-sync',
      url: 'https://bitbucket.example.com/northwind/ledger/pipelines/1839',
      title: 'The pipeline on feature/ledger-sync failed on the first run.',
      asker: 'Bitbucket Pipelines',
      due: 'today',
      pushLevel: 'normal',
      probability: 0.88,
      createdAt: at(-1, 18, 30),
      closedAt: at(0, 7, 12),
      closeReason: 'evidence',
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
      action: { kind: 'work', workId: NEEDS_YOU_FIXTURE_WORK_ID },
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

/**
 * What `obligationViews:forWork` answers for the Q3 review deck: its open
 * items and the items closed today, in no particular order. The thread sorts
 * them by time.
 */
export function workObligationsFixture(
  now = NEEDS_YOU_FIXTURE_NOW,
  timezone = NEEDS_YOU_FIXTURE_TIMEZONE,
): ObligationView[] {
  return needsYouFixture(now, timezone).items.filter((entry) => entry.workId === NEEDS_YOU_FIXTURE_WORK_ID);
}

/**
 * The daily letter of a flag user: the `needs-you` lane in the place of
 * `answer`. The lane is a stack: the rows, then the plain line about what
 * closed by itself since the last letter.
 */
export function needsYouLetterFixture(): BriefDocumentV2 {
  const region: BriefRegion = {
    id: 'needs-you',
    summary: '8 open · 2 now · 2 due today',
    tree: {
      kind: 'stack',
      emphasis: 'primary',
      tone: 'neutral',
      density: 'standard',
      children: [
        {
          kind: 'entity_list',
          emphasis: 'primary',
          tone: 'neutral',
          title: 'Needs you',
          variant: 'rows',
          items: [
            {
              ref: {
                kind: 'thread',
                id: 'thr_harbor_air',
                account: 'alex@example.com',
                label: 'Flight HA 220 moved to 6:40 PM',
              },
              framing: {
                lane: 'now',
                sender: 'Harbor Air',
                age: '9:12 AM',
                reason: 'Your calendar still has 3:15 PM and a car at 1:30 PM.',
              },
              actions: [
                {
                  action: 'open_thread',
                  label: 'Open',
                  payload: { account: 'alex@example.com', threadId: 'thr_harbor_air' },
                  style: 'quiet',
                },
              ],
            },
            {
              ref: {
                kind: 'work',
                id: NEEDS_YOU_FIXTURE_WORK_ID,
                label: 'Which quarter numbers should the deck use?',
              },
              framing: {
                lane: 'now',
                sender: NEEDS_YOU_FIXTURE_WORK_TITLE,
                age: 'Albatross',
                reason: 'The run waits for your answer.',
              },
              actions: [
                {
                  action: 'open_work',
                  label: 'Answer',
                  payload: { workId: NEEDS_YOU_FIXTURE_WORK_ID },
                  style: 'quiet',
                },
              ],
            },
            {
              ref: {
                kind: 'mcp',
                id: 'granola:meeting:vendor-sync-1027',
                label: 'Send the signed NDA to Harbor Labs',
              },
              framing: {
                lane: 'today',
                sender: 'Vendor sync',
                age: 'Granola · yesterday',
                reason: 'You said so in the meeting. The signed file is in Files.',
              },
              actions: [
                {
                  action: 'open_url',
                  label: 'Open',
                  payload: { url: 'https://notes.example.com/d/vendor-sync-1027' },
                  style: 'quiet',
                },
              ],
            },
            {
              ref: {
                kind: 'mcp',
                id: 'github:northwind/web:pull:491',
                label: 'Review northwind/web #491 before the release',
              },
              framing: {
                lane: 'today',
                sender: 'Maya Chen',
                age: 'GitHub · 8:05 AM',
                reason: 'Fix the ledger rounding. 14 files changed.',
              },
              actions: [
                {
                  action: 'open_url',
                  label: 'Open review',
                  payload: { url: 'https://github.example.com/northwind/web/pull/491' },
                  style: 'quiet',
                },
              ],
            },
          ],
        },
        {
          kind: 'text',
          emphasis: 'muted',
          tone: 'neutral',
          role: 'caption',
          text: 'Closed by itself since yesterday’s letter: the pipeline on feature/ledger-sync passed on its second run, and the Northwind Bank code went into AutoFill at 7:58 AM.',
        },
      ],
    },
  };
  return {
    ...letterBriefDocumentFixture,
    title: 'The Wednesday Brief',
    summary:
      'Two things need you before the day gets going: a flight that moved to the evening, and a question that holds the Q3 deck. Two more are due today.',
    regions: letterBriefDocumentFixture.regions.map((entry) =>
      entry.id === 'lede'
        ? {
            ...entry,
            summary: 'Two things need you before the day gets going.',
            tree: {
              kind: 'hero',
              emphasis: 'primary',
              tone: 'neutral',
              surface: 'plain',
              children: [
                {
                  kind: 'text',
                  emphasis: 'primary',
                  tone: 'neutral',
                  role: 'lede',
                  text: 'Two things need you before the day gets going: a flight that moved to the evening, and a question that holds the Q3 deck. Two more are due today.',
                },
              ],
            },
          }
        : entry.id === 'answer'
          ? region
          : entry,
    ),
  };
}

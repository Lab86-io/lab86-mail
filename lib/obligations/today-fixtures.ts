// The live Today page over invented data, for the preview and the tests. Every
// person and company is invented. The clock is NEEDS_YOU_FIXTURE_NOW: Wednesday,
// October 28, 2026, 11:05 AM in Los Angeles.

import type { DailyReportWorthKnowing } from '@/lib/shared/types';
import type { ObligationView } from './contract';
import { NEEDS_YOU_FIXTURE_NOW as NOW } from './fixtures';
import type { TodayScheduleEvent } from './today-page';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function item(overrides: Partial<ObligationView> & Pick<ObligationView, 'id' | 'kind' | 'title' | 'asker'>) {
  return {
    state: 'open',
    source: 'mail',
    sourceKey: `mail:acct:${overrides.id}`,
    due: 'none',
    pushLevel: 'none',
    probability: 0.92,
    createdAt: NOW - 3 * HOUR,
    updatedAt: NOW - 3 * HOUR,
    ...overrides,
  } as ObligationView;
}

export const TODAY_PREVIEW_ITEMS: ObligationView[] = [
  item({
    id: 'tp_flight',
    kind: 'change',
    title: 'Flight HA 220 now departs at 6:40 PM from gate C12.',
    asker: 'Harbor Air',
    pushLevel: 'time_sensitive',
    createdAt: NOW - 40 * 60_000,
    updatedAt: NOW - 40 * 60_000,
  }),
  item({
    id: 'tp_rsvp',
    kind: 'rsvp',
    title: 'Answer the invitation: Vendor review',
    asker: 'Dana Whitfield',
    source: 'calendar',
    sourceKey: 'calendar:acct:vendor',
    sourceLabel: 'Vendor review',
    eventId: 'vendor',
    eventStart: NOW + 26 * HOUR,
    due: 'soon',
    dueAt: NOW + 26 * HOUR,
  }),
  item({
    id: 'tp_julie',
    kind: 'reply',
    title: 'What works for you to send the licensing terms to the press office?',
    asker: 'Marin Okafor',
    createdAt: NOW - 20 * HOUR,
    updatedAt: NOW - 20 * HOUR,
    draftReady: true,
    threadId: 'th1',
    accountId: 'acct',
    messageId: 'm1',
  }),
  item({
    id: 'tp_review',
    kind: 'action',
    title: 'Review: Move the invoice export to the new queue',
    asker: 'Priya Raman',
    source: 'github',
    sourceKey: 'github:northwind/web#491',
    sourceLabel: 'northwind/web #491',
    due: 'today',
    createdAt: NOW - 5 * HOUR,
    updatedAt: NOW - 5 * HOUR,
  }),
  ...[0, 1, 2].map((index) =>
    item({
      id: `tp_pay_${index}`,
      kind: 'change',
      title: 'Your payment of $36.00 could not be processed.',
      asker: 'Lumen Hosting',
      due: 'today',
      createdAt: NOW - (8 + index * 24) * HOUR,
      updatedAt: NOW - (8 + index * 24) * HOUR,
    }),
  ),
  item({
    id: 'tp_nda',
    kind: 'action',
    title: 'Please sign the updated NDA before the kickoff.',
    asker: 'Tomás Rivera',
    due: 'soon',
    dueAt: NOW + 2 * DAY,
  }),
  item({
    id: 'tp_card',
    kind: 'change',
    title: 'The card ending 4410 expires next month.',
    asker: 'Bramble Press',
    createdAt: NOW - 30 * HOUR,
    updatedAt: NOW - 30 * HOUR,
  }),
  item({
    id: 'tp_slack',
    kind: 'action',
    title: 'Can you send the Q3 numbers before the board call?',
    asker: 'Sam Lindqvist',
    source: 'slack',
    sourceKey: 'slack:C1:1',
    sourceLabel: '#finance',
    createdAt: NOW - 26 * HOUR,
    updatedAt: NOW - 26 * HOUR,
  }),
];

function event(
  id: string,
  title: string,
  fromHour: number,
  toHour: number,
  location?: string,
): TodayScheduleEvent {
  // NOW is 11:05 AM, so an hour of the day is an offset from it.
  const start = NOW - (11 + 5 / 60) * HOUR;
  return {
    id,
    title,
    startAt: start + fromHour * HOUR,
    endAt: start + toHour * HOUR,
    ...(location ? { location } : {}),
  };
}

export const TODAY_PREVIEW_EVENTS: TodayScheduleEvent[] = [
  event('standup', 'Team standup', 9.5, 9.75),
  event('design', 'Design review', 10.5, 11.5, 'Studio'),
  event('lunch', 'Lunch with Mara', 12, 13, 'Ostro'),
  event('board', 'Board prep', 15, 16, 'Room 2'),
  event('squash', 'Squash', 19, 20),
];

export const TODAY_PREVIEW_WORTH: DailyReportWorthKnowing[] = [
  {
    title: 'Northwind renews on November 12.',
    line: 'The seat price rises 8 percent.',
  },
  {
    title: 'Your water bill fell.',
    line: 'October was $41, down from $63 in September.',
  },
];

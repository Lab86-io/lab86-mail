import { describe, expect, test } from 'bun:test';
import { type JevAssessment, ROUTINE_NOTICE_QUESTION, routineNoticeProbability } from '../lib/jev/contract';
import { assessmentFromResponse, buildMailQuestions } from '../lib/jev/mail';
import { CHANGE_AUTO_CLOSE_MS, CHANGE_NOW_WINDOW_MS } from '../lib/obligations/contract';
import {
  type CalendarEventFacts,
  calendarEventId,
  calendarSourceKey,
  changeIsProblem,
  connectorSourceLabel,
  contentItemFacts,
  contentObligation,
  contentObligationSource,
  isRoutineNotice,
  type MailThreadFacts,
  mailObligations,
  otherPeople,
  ownerFacts,
  ownerFactText,
  ownParticipant,
  PREPARE_WINDOW_MS,
  prepareCandidate,
  prepareObligation,
  prepareRevision,
  RSVP_WINDOW_MS,
  rsvpObligation,
  sweepAtFor,
  sweepStep,
} from '../lib/obligations/rules';
import { assessment, mailInput, NOW, responseFor } from './fixtures/jev';

// Invented people, companies, and services only. The cases copy the shape of
// the phase 1 production fill (2026-10-30): most changes were routine
// notices, and four were real problems.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NY = 'America/New_York';
const settings = { vipSenders: [] as string[], timezone: NY };

function facts(
  subject: string,
  body: string,
  date = NOW,
  from = 'Service <notice@service.test>',
): MailThreadFacts {
  return {
    accountId: 'account-a',
    threadId: 'thread-a',
    subject,
    messages: [{ id: 'm1', from, to: 'owner@example.test', subject, body, date }],
    selfAddresses: ['owner@example.test'],
  };
}

function change(
  subjectKind: JevAssessment['subjectKind'],
  text: string,
  routine?: number,
  extra: Partial<JevAssessment> = {},
): JevAssessment {
  return assessment({
    purpose: 'transaction',
    subjectKind,
    obligations: [],
    meaningfulChange: true,
    changeEvidence: { messageId: 'm1', text },
    probabilities: {
      reply: 0.02,
      action: 0.02,
      waiting: 0.02,
      change: 0.95,
      ...(routine === undefined ? {} : { [ROUTINE_NOTICE_QUESTION]: routine }),
    },
    ...extra,
  });
}

describe('the routine_notice question (phase 1.1)', () => {
  test('the mail questions ask it; the question version does not change', () => {
    const questions = buildMailQuestions(mailInput());
    expect(questions[ROUTINE_NOTICE_QUESTION]).toMatchObject({ type: 'noul' });
    expect((questions[ROUTINE_NOTICE_QUESTION] as any).instructions).toContain('routine notice');
    const stored = assessmentFromResponse(
      mailInput(),
      responseFor(mailInput(), { [ROUTINE_NOTICE_QUESTION]: 0.91 }),
      NOW,
    );
    expect(stored.questionVersion).toBe('mail-1');
    expect(stored.version).toBe(1);
    expect(routineNoticeProbability(stored)).toBe(0.91);
  });

  test('a response without the answer stores none, and an old verdict reads as no answer', () => {
    const missing = responseFor(mailInput());
    delete (missing.answers as any)[ROUTINE_NOTICE_QUESTION];
    expect(routineNoticeProbability(assessmentFromResponse(mailInput(), missing, NOW))).toBeUndefined();
    const wrong = responseFor(mailInput());
    (wrong.answers as any)[ROUTINE_NOTICE_QUESTION] = { type: 'choice', choice: 'x', confidence: 1 };
    expect(routineNoticeProbability(assessmentFromResponse(mailInput(), wrong, NOW))).toBeUndefined();
    expect(routineNoticeProbability(assessment())).toBeUndefined();
    expect(routineNoticeProbability(null)).toBeUndefined();
  });

  test('a Jev answer decides; an old verdict reads the cues, and a problem cancels them', () => {
    expect(isRoutineNotice(change('account', 'We changed our terms.', 0.9), 'Terms update')).toBe(true);
    expect(isRoutineNotice(change('account', 'We changed our terms.', 0.3), 'Terms update')).toBe(false);
    expect(isRoutineNotice(change('finance', 'Read the new terms of service.'), 'Account news')).toBe(true);
    expect(isRoutineNotice(change('finance', 'Your plan will renew on May 3.'), 'Plan')).toBe(true);
    expect(isRoutineNotice(change('finance', 'Your renewal payment failed.'), 'Your plan will renew')).toBe(
      false,
    );
    expect(isRoutineNotice(change('booking', 'Your table is moved to 8 pm.'), 'Reservation')).toBe(false);
    expect(isRoutineNotice(assessment({ changeEvidence: undefined }), 'Lunch?')).toBe(false);
  });

  test('a problem cue must match the subject kind', () => {
    expect(changeIsProblem('finance', 'Receipt', 'Your card was declined.')).toBe(true);
    expect(changeIsProblem('finance', 'Payment', "We couldn't process your payment.")).toBe(true);
    expect(changeIsProblem('booking', 'Event cancelled: Design review', 'The organizer cancelled it.')).toBe(
      true,
    );
    expect(changeIsProblem('account', 'Certificate', 'Your signing certificate was revoked.')).toBe(true);
    expect(changeIsProblem('account', 'Welcome', 'Your profile is ready.')).toBe(false);
    expect(changeIsProblem('order', 'Order', 'Your order was cancelled.')).toBe(false);
    // The footer of a long notice does not count: only the opening is read.
    expect(
      changeIsProblem(
        'booking',
        'Booking confirmed',
        `${'Your stay is confirmed. '.repeat(40)}Need to cancel? Reply.`,
      ),
    ).toBe(false);
  });
});

describe('phase 1.1 change rules (invented equivalents of the production fill)', () => {
  const at = NOW;
  const fresh = at - 2 * HOUR;
  const realProblems: Array<[string, JevAssessment['subjectKind'], string, string]> = [
    [
      'a failed subscription payment',
      'finance',
      'Your Northwind Cloud payment failed',
      'We could not charge your card for the Plus plan.',
    ],
    [
      'a revoked signing certificate',
      'account',
      'Your signing certificate was revoked',
      'The certificate for Harbor Labs is revoked. Apps signed with it will not install.',
    ],
    [
      'a cancelled calendar event',
      'booking',
      'Event cancelled: Design review',
      'Rosa Diaz cancelled this event.',
    ],
    [
      'a moved meeting time',
      'booking',
      'Updated invitation: Planning call',
      'The planning call is rescheduled to 3 pm on Thursday.',
    ],
  ];
  for (const [name, kind, subject, body] of realProblems)
    test(`keeps ${name} as a new, time-sensitive change`, () => {
      const [item] = mailObligations(change(kind, body, 0.04), facts(subject, body, fresh), settings, at);
      expect(item).toMatchObject({ kind: 'change', pushLevel: 'time_sensitive', sourceAt: fresh });
    });

  const routine: Array<[string, JevAssessment['subjectKind'], string, string]> = [
    [
      'a payments terms update',
      'finance',
      'Updates to our services agreement',
      'We are updating the Bluefin Pay services agreement on Dec 1.',
    ],
    [
      'a wallet terms change',
      'finance',
      'Changes to the Harbor Cash terms',
      'The Harbor Cash terms and conditions change next month.',
    ],
    [
      'a newspaper renewal notice',
      'finance',
      'Your subscription renews soon',
      'Your Daily Ledger subscription will renew on November 12.',
    ],
    [
      'a card service notice',
      'account',
      'Service notice',
      'An update to how Corvid Card shows your statement.',
    ],
  ];
  for (const [name, kind, subject, body] of routine)
    test(`drops ${name} when Jev calls it routine, and by the cues for an old verdict`, () => {
      expect(mailObligations(change(kind, body, 0.93), facts(subject, body, fresh), settings, at)).toEqual(
        [],
      );
      expect(mailObligations(change(kind, body), facts(subject, body, fresh), settings, at)).toEqual([]);
    });

  test('an old security alert has aged out: it opens nothing', () => {
    const old = at - 9 * DAY;
    const body = 'A new sign-in to your Lumen account from a Mac. If this was you, do nothing.';
    expect(
      mailObligations(change('account', body, 0.1), facts('Security alert', body, old), settings, at),
    ).toEqual([]);
  });

  test('an app permission request is a change in-app only, and closes by itself later', () => {
    const body = 'The Relay app requests updated permissions for the northwind organization.';
    const [item] = mailObligations(
      change('account', body, 0.2),
      facts('Permission request', body, fresh),
      settings,
      at,
    );
    expect(item).toMatchObject({ kind: 'change', pushLevel: 'none' });
    expect(sweepAtFor({ ...item, state: 'open', openedAt: at })).toBe(fresh + CHANGE_AUTO_CLOSE_MS);
  });

  test('a problem older than the Now window is a change without the time-sensitive level', () => {
    const twoDays = at - CHANGE_NOW_WINDOW_MS - HOUR;
    const body = 'Your payment failed.';
    const [item] = mailObligations(change('finance', body), facts('Payment', body, twoDays), settings, at);
    expect(item).toMatchObject({ kind: 'change', pushLevel: 'none' });
  });

  test('the 30-day fill never makes a time-sensitive row', () => {
    const body = 'Your payment failed.';
    const [item] = mailObligations(
      change('finance', body),
      facts('Payment', body, fresh),
      { ...settings, fill: true },
      at,
    );
    expect(item.pushLevel).toBe('none');
  });

  test('a routine notice drops its action, and keeps a reply that a person asked', () => {
    const verdict = change('finance', 'Your plan will renew on May 3.', 0.95, {
      purpose: 'conversation',
      obligations: [
        {
          kind: 'action',
          evidence: { messageId: 'm1', text: 'Please review the new terms.' },
          probability: 0.9,
        },
        {
          kind: 'reply',
          evidence: { messageId: 'm1', text: 'Can you confirm by Friday?' },
          probability: 0.95,
        },
      ],
    });
    const items = mailObligations(verdict, facts('Plan', 'Can you confirm by Friday?', fresh), settings, at);
    expect(items.map((item) => item.kind)).toEqual(['reply']);
  });
});

describe('connected sources (phase 2)', () => {
  test('sources map to obligation sources; mail, attachments, and documents do not', () => {
    expect(
      ['slack', 'jira', 'atlassian', 'granola', 'google_drive', 'onedrive', 'github', 'bitbucket'].map(
        contentObligationSource,
      ),
    ).toEqual(['slack', 'atlassian', 'atlassian', 'granola', 'drive', 'drive', 'github', 'bitbucket']);
    expect(contentObligationSource('mail')).toBeUndefined();
    expect(contentObligationSource('document')).toBeUndefined();
  });

  test('owner facts keep a fixed order, drop unknown values, and read as sentences', () => {
    expect(ownerFacts(['checks_failed', 'x', 'review_requested'])).toEqual([
      'review_requested',
      'checks_failed',
    ]);
    expect(ownerFacts('review_requested')).toEqual([]);
    expect(ownerFactText(['assigned', 'mentioned', 'authored'])).toBe(
      'The owner is mentioned in this item.\nThis item is assigned to the owner.\nThe owner opened this item.',
    );
    expect(ownerFactText(undefined)).toBe('');
  });

  test('the source label names the place in each source', () => {
    expect(connectorSourceLabel('slack', 't', { externalId: 'x', raw: { channelName: 'release' } })).toBe(
      '#release',
    );
    expect(connectorSourceLabel('slack', 't', { externalId: 'x', raw: { directMessage: true } })).toBe(
      'Direct message',
    );
    expect(connectorSourceLabel('slack', 't', { externalId: 'x' })).toBe('Slack');
    expect(connectorSourceLabel('jira', 't', { externalId: 'x', raw: { key: 'LAB-212' } })).toBe('LAB-212');
    expect(connectorSourceLabel('jira', 't', { externalId: 'x', raw: {} })).toBeUndefined();
    expect(connectorSourceLabel('github', 't', { externalId: 'github:pull_request:northwind/web#482' })).toBe(
      'northwind/web #482',
    );
    expect(
      connectorSourceLabel('github', 't', { externalId: 'github:project:P1', repository: 'northwind/web' }),
    ).toBe('northwind/web');
    expect(
      connectorSourceLabel('bitbucket', 't', {
        externalId: 'u',
        raw: { id: 7, destination: { repository: { full_name: 'harbor/api' } } },
      }),
    ).toBe('harbor/api #7');
    expect(
      connectorSourceLabel('bitbucket', 't', {
        externalId: 'u',
        raw: { source: { repository: { full_name: 'harbor/api' } } },
      }),
    ).toBe('harbor/api');
    expect(connectorSourceLabel('bitbucket', 't', { externalId: 'u', raw: {} })).toBeUndefined();
    expect(connectorSourceLabel('granola', 'Weekly sync', undefined)).toBe('Weekly sync');
    expect(connectorSourceLabel('google_drive', '', undefined)).toBeUndefined();
  });

  const item = (patch: Partial<Parameters<typeof contentItemFacts>[0]> = {}) => ({
    source: 'slack',
    title: '#release · Rosa Diaz: can you sign off on the release notes?',
    text: '#release · Rosa Diaz: can you sign off on the release notes?\nCan you sign off on the release notes by today?',
    url: 'https://northwind.slack.test/archives/C1/p1',
    modifiedAt: NOW - HOUR,
    deleted: false,
    ...patch,
  });
  const labels = { kind: 'request', actionable: true, resolved: false, workId: null };

  test('an actionable Slack request opens an action that pushes when it is due soon', () => {
    const facts = contentItemFacts(item(), {
      externalId: 'slack:T:C1:1',
      author: 'Rosa Diaz',
      raw: { channelName: 'release' },
    });
    const wanted = contentObligation(
      facts,
      { ...labels, due: 'today', actionableProbability: 0.93 },
      settings,
      NOW,
    );
    expect(wanted).toMatchObject({
      kind: 'action',
      asker: 'Rosa Diaz',
      title: 'Can you sign off on the release notes by today?',
      due: 'today',
      probability: 0.93,
      pushLevel: 'normal',
      sourceLabel: '#release',
      url: 'https://northwind.slack.test/archives/C1/p1',
      sourceAt: NOW - HOUR,
    });
    expect(wanted?.why).toBe('This Slack item asks you to do something that is not done yet.');
    // No due date, no VIP, no recent Albatross: in-app only.
    expect(contentObligation(facts, labels, settings, NOW)?.pushLevel).toBe('none');
    // An old label without its probability is at the push bar.
    expect(contentObligation(facts, { ...labels, due: 'soon' }, settings, NOW)?.pushLevel).toBe('normal');
    expect(
      contentObligation(facts, { ...labels, due: 'soon', actionableProbability: 0.8 }, settings, NOW)
        ?.pushLevel,
    ).toBe('none');
    expect(
      contentObligation(facts, { ...labels, due: 'soon' }, { ...settings, fill: true }, NOW)?.pushLevel,
    ).toBe('none');
  });

  test('a recent Albatross or a VIP pushes; a proposal is not an Albatross; a dull text uses the title', () => {
    const facts = contentItemFacts(item({ text: 'ok', title: 'LAB-212: Ship the export', source: 'jira' }), {
      externalId: 'jira:s:1',
      raw: { key: 'LAB-212' },
    });
    const work = contentObligation(
      facts,
      { ...labels, workId: 'w1' },
      { ...settings, recentWorkIds: ['w1'] },
      NOW,
    );
    expect(work).toMatchObject({
      workId: 'w1',
      pushLevel: 'normal',
      asker: 'Jira',
      title: 'Action needed: LAB-212: Ship the export',
    });
    expect(
      contentObligation(facts, { ...labels, workId: 'proposal:p1' }, settings, NOW)?.workId,
    ).toBeUndefined();
    const vip = contentItemFacts(item({ source: 'github' }), {
      externalId: 'x',
      author: 'Maya <maya@northwind.test>',
    });
    expect(
      contentObligation(vip, labels, { ...settings, vipSenders: ['maya@northwind.test'] }, NOW),
    ).toMatchObject({
      askerAddress: 'maya@northwind.test',
      pushLevel: 'normal',
    });
  });

  test('an owner fact leads the title; Drive and Granola stay in-app; only https links are kept', () => {
    const review = contentItemFacts(
      item({ source: 'github', title: 'Add the export button', url: 'http://plain.test/x' }),
      {
        externalId: 'github:pull_request:northwind/web#482',
        author: 'octo-maya',
        raw: { ownerFacts: ['review_requested'] },
      },
    );
    const wanted = contentObligation(review, { ...labels, due: 'today' }, settings, NOW);
    expect(wanted).toMatchObject({
      title: 'Review: Add the export button',
      sourceLabel: 'northwind/web #482',
    });
    expect(wanted?.url).toBeUndefined();
    const bad = contentItemFacts(item({ url: 'not a url' }), undefined);
    expect(contentObligation(bad, labels, settings, NOW)?.url).toBeUndefined();
    for (const source of ['google_drive', 'granola'])
      expect(
        contentObligation(
          contentItemFacts(item({ source }), { externalId: 'x', author: 'Ana' }),
          { ...labels, due: 'today' },
          settings,
          NOW,
        )?.pushLevel,
      ).toBe('none');
    expect(
      contentObligation(
        contentItemFacts(item({ source: 'google_drive', title: '' }), undefined),
        labels,
        settings,
        NOW,
      )?.asker,
    ).toBe('Drive');
  });

  test('noise, resolved, not actionable, deleted, old, excluded, and unknown sources open nothing', () => {
    const facts = contentItemFacts(item(), undefined);
    expect(contentObligation(facts, { ...labels, kind: 'noise' }, settings, NOW)).toBeNull();
    expect(contentObligation(facts, { ...labels, resolved: true }, settings, NOW)).toBeNull();
    expect(contentObligation(facts, { ...labels, actionable: false }, settings, NOW)).toBeNull();
    expect(contentObligation({ ...facts, deleted: true }, labels, settings, NOW)).toBeNull();
    expect(contentObligation({ ...facts, modifiedAt: NOW - 40 * DAY }, labels, settings, NOW)).toBeNull();
    expect(contentObligation(facts, labels, { ...settings, excluded: true }, NOW)).toBeNull();
    expect(contentObligation({ ...facts, source: 'document' }, labels, settings, NOW)).toBeNull();
  });
});

describe('calendar (phase 4)', () => {
  const event = (patch: Partial<CalendarEventFacts> = {}): CalendarEventFacts => ({
    accountId: 'account-a',
    providerCalendarId: 'cal-1',
    providerEventId: 'evt-1',
    title: 'Budget review',
    description: 'Bring the Q3 numbers.',
    startAt: NOW + 2 * DAY,
    endAt: NOW + 2 * DAY + HOUR,
    organizer: { name: 'Rosa Diaz', email: 'rosa@northwind.test' },
    participants: [
      { name: 'Rosa Diaz', email: 'rosa@northwind.test', status: 'yes' },
      { name: 'Owner', email: 'Owner@Example.test', status: 'noreply' },
      { name: 'Room 4', email: 'c_room4@resource.calendar.google.com', status: 'yes' },
    ],
    htmlLink: 'https://calendar.example.test/event?eid=1',
    ...patch,
  });
  const self = ['owner@example.test'];

  test('keys, the own participant, and the other people', () => {
    expect(calendarEventId({ providerEventId: 'evt-1_20261101', masterEventId: 'evt-1' })).toBe('evt-1');
    expect(calendarEventId({ providerEventId: 'evt-2' })).toBe('evt-2');
    expect(calendarSourceKey('account-a', 'evt-1')).toBe('calendar:account-a:evt-1');
    expect(ownParticipant(event(), self)?.status).toBe('noreply');
    expect(ownParticipant(event({ participants: null }), self)).toBeUndefined();
    expect(otherPeople(event(), self).map((person) => person.email)).toEqual(['rosa@northwind.test']);
    expect(otherPeople(event({ participants: [{}] }), self)).toEqual([]);
  });

  test('an invitation without an answer opens an rsvp; due follows the start', () => {
    const wanted = rsvpObligation(event(), self, NOW);
    expect(wanted).toMatchObject({
      kind: 'rsvp',
      title: 'Answer the invitation: Budget review',
      asker: 'Rosa Diaz',
      askerAddress: 'rosa@northwind.test',
      why: 'Rosa Diaz invited you. You have not answered yet.',
      excerpt: 'Bring the Q3 numbers.',
      due: 'soon',
      dueAt: NOW + 2 * DAY,
      pushLevel: 'none',
      sourceLabel: 'Budget review',
      url: 'https://calendar.example.test/event?eid=1',
      eventId: 'evt-1',
      calendarId: 'cal-1',
      eventStart: NOW + 2 * DAY,
    });
    expect(rsvpObligation(event({ startAt: NOW + 3 * HOUR }), self, NOW)?.due).toBe('today');
    expect(rsvpObligation(event({ startAt: NOW + 6 * DAY }), self, NOW)?.due).toBe('later');
    const series = rsvpObligation(
      event({
        providerEventId: 'evt-1_x',
        masterEventId: 'evt-1',
        title: '',
        description: undefined,
        htmlLink: undefined,
      }),
      self,
      NOW,
    );
    expect(series).toMatchObject({ eventId: 'evt-1', title: 'Answer the invitation: (no title)' });
    expect(series?.excerpt).toBeUndefined();
    expect(series?.url).toBeUndefined();
    // A participant row without a status waits for an answer too.
    expect(
      rsvpObligation(event({ participants: [{ email: 'owner@example.test' }] }), self, NOW),
    ).not.toBeNull();
    expect(rsvpObligation(event({ organizer: { email: 'rosa@northwind.test' } }), self, NOW)?.asker).toBe(
      'rosa@northwind.test',
    );
  });

  test('an answer, the owner as organizer, a cancel, or a start outside the window opens no rsvp', () => {
    const answered = event({ participants: [{ email: 'owner@example.test', status: 'yes' }] });
    expect(rsvpObligation(answered, self, NOW)).toBeNull();
    expect(rsvpObligation(event({ organizer: { email: 'owner@example.test' } }), self, NOW)).toBeNull();
    expect(rsvpObligation(event({ organizer: null }), self, NOW)).toBeNull();
    expect(rsvpObligation(event({ participants: [] }), self, NOW)).toBeNull();
    expect(rsvpObligation(event({ status: 'cancelled' }), self, NOW)).toBeNull();
    expect(rsvpObligation(event({ startAt: NOW - HOUR }), self, NOW)).toBeNull();
    expect(rsvpObligation(event({ startAt: NOW + RSVP_WINDOW_MS + HOUR }), self, NOW)).toBeNull();
  });

  test('prepare: candidates in the next 24 hours with other people, not declined', () => {
    const soon = event({ startAt: NOW + 3 * HOUR });
    expect(prepareCandidate(soon, self, NOW)).toBe(true);
    expect(prepareCandidate(event(), self, NOW)).toBe(false);
    expect(prepareCandidate({ ...soon, startAt: NOW + PREPARE_WINDOW_MS + 1 }, self, NOW)).toBe(false);
    expect(prepareCandidate({ ...soon, allDay: true }, self, NOW)).toBe(false);
    expect(prepareCandidate({ ...soon, status: 'cancelled' }, self, NOW)).toBe(false);
    expect(prepareCandidate({ ...soon, participants: [{ email: 'owner@example.test' }] }, self, NOW)).toBe(
      false,
    );
    expect(
      prepareCandidate(
        {
          ...soon,
          participants: [{ email: 'rosa@northwind.test' }, { email: 'owner@example.test', status: 'no' }],
        },
        self,
        NOW,
      ),
    ).toBe(false);
  });

  test('prepare: opens at 0.75, pushes at the push bar, names the organizer or another person', () => {
    const soon = event({ startAt: NOW + 3 * HOUR });
    expect(prepareObligation(soon, 0.7, self, {}, NOW)).toBeNull();
    expect(prepareObligation(event(), 0.95, self, {}, NOW)).toBeNull();
    expect(prepareObligation(soon, 0.8, self, {}, NOW)).toMatchObject({
      kind: 'prepare',
      title: 'Prepare for Budget review',
      asker: 'Rosa Diaz',
      due: 'today',
      dueAt: NOW + 3 * HOUR,
      pushLevel: 'none',
      eventId: 'evt-1',
      calendarId: 'cal-1',
    });
    expect(prepareObligation(soon, 0.9, self, {}, NOW)?.pushLevel).toBe('normal');
    expect(prepareObligation(soon, 0.9, self, { fill: true }, NOW)?.pushLevel).toBe('none');
    const own = prepareObligation(
      {
        ...soon,
        organizer: { email: 'owner@example.test' },
        description: undefined,
        htmlLink: undefined,
        title: '',
      },
      0.9,
      self,
      {},
      NOW,
    );
    expect(own).toMatchObject({
      asker: 'Rosa Diaz',
      askerAddress: 'rosa@northwind.test',
      title: 'Prepare for (no title)',
    });
    expect(own?.excerpt).toBeUndefined();
  });

  test('the prepare revision changes with the parts the question reads', () => {
    const base = event();
    expect(prepareRevision(base)).toBe(prepareRevision({ ...base, htmlLink: 'https://other.test' }));
    expect(prepareRevision(base)).not.toBe(prepareRevision({ ...base, description: 'Read the memo.' }));
    expect(prepareRevision({ ...base, participants: null, description: undefined })).toMatch(/^prepare-1:/);
  });
});

describe('the sweep (sweepAtFor, sweepStep)', () => {
  const row = (patch: Record<string, unknown> = {}) => ({
    kind: 'change' as const,
    state: 'open',
    pushLevel: 'time_sensitive' as const,
    sourceAt: NOW,
    openedAt: NOW,
    ...patch,
  });

  test('a time-sensitive change leaves Now, then ages out; a calendar item ends at its start', () => {
    expect(sweepAtFor(row())).toBe(NOW + CHANGE_NOW_WINDOW_MS);
    expect(sweepAtFor(row({ pushLevel: 'none', sourceAt: undefined }))).toBe(NOW + CHANGE_AUTO_CLOSE_MS);
    expect(sweepAtFor(row({ kind: 'rsvp', eventStart: NOW + DAY }))).toBe(NOW + DAY);
    expect(sweepAtFor(row({ kind: 'prepare' }))).toBeUndefined();
    expect(sweepAtFor(row({ kind: 'reply' }))).toBeUndefined();
    expect(sweepAtFor(row({ state: 'done' }))).toBeUndefined();
  });

  test('steps: demote, close as aged_out, close as event_passed, defer, or nothing', () => {
    expect(sweepStep(row(), NOW + HOUR)).toEqual({ action: 'defer', sweepAt: NOW + CHANGE_NOW_WINDOW_MS });
    expect(sweepStep(row(), NOW + CHANGE_NOW_WINDOW_MS)).toEqual({
      action: 'demote',
      sweepAt: NOW + CHANGE_AUTO_CLOSE_MS,
    });
    expect(sweepStep(row({ pushLevel: 'normal' }), NOW + CHANGE_AUTO_CLOSE_MS)).toEqual({
      action: 'close',
      state: 'resolved',
      closeReason: 'aged_out',
    });
    expect(sweepStep(row({ state: 'snoozed', snoozedUntil: NOW + 5 * DAY }), NOW + 4 * DAY)).toEqual({
      action: 'defer',
      sweepAt: NOW + 5 * DAY,
    });
    expect(sweepStep(row({ state: 'snoozed', snoozedUntil: NOW + DAY }), NOW + 4 * DAY).action).toBe('close');
    const rsvp = row({ kind: 'rsvp', state: 'snoozed', snoozedUntil: NOW + 9 * DAY, eventStart: NOW + DAY });
    expect(sweepStep(rsvp, NOW + DAY)).toEqual({
      action: 'close',
      state: 'expired',
      closeReason: 'event_passed',
    });
    expect(sweepStep(rsvp, NOW)).toEqual({ action: 'defer', sweepAt: NOW + DAY });
    expect(sweepStep(row({ kind: 'prepare' }), NOW)).toEqual({ action: 'none' });
    expect(sweepStep(row({ kind: 'reply' }), NOW)).toEqual({ action: 'none' });
    expect(sweepStep(row({ state: 'resolved' }), NOW)).toEqual({ action: 'none' });
  });
});

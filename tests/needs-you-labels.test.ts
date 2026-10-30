import { describe, expect, test } from 'bun:test';
import type { ObligationView } from '../lib/obligations/contract';
import { NEEDS_YOU_FIXTURE_NOW, NEEDS_YOU_FIXTURE_TIMEZONE } from '../lib/obligations/fixtures';
import {
  actionNote,
  actionToastTitle,
  agoLabel,
  albatrossNote,
  canSendReply,
  canStartAlbatross,
  closeReasonLabel,
  dueDayLabel,
  dueLabel,
  dueSentence,
  eventStartLabel,
  expiryFraction,
  expiryLabel,
  kindLabel,
  obligationSentence,
  openInLabel,
  primaryAction,
  primaryPillLabel,
  rowLeadKind,
  safeSourceUrl,
  safeTimeZone,
  sourceWord,
  sourceWords,
  spacedCode,
  whenLabel,
} from '../lib/obligations/labels';

/* The words of a row and a detail on the Needs you page. */

const TZ = NEEDS_YOU_FIXTURE_TIMEZONE;
// Wednesday, October 28, 2026, 11:05 AM in Los Angeles.
const NOW = NEEDS_YOU_FIXTURE_NOW;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START_OF_TODAY = Date.UTC(2026, 9, 28, 7, 0, 0);

const item = (overrides: Partial<ObligationView> = {}): ObligationView => ({
  id: 'ob',
  kind: 'reply',
  state: 'open',
  source: 'mail',
  sourceKey: 'mail:acct:thread',
  title: 'Asks for a reply.',
  asker: 'Ada Example',
  due: 'none',
  pushLevel: 'normal',
  probability: 0.9,
  createdAt: NOW - HOUR,
  updatedAt: NOW - HOUR,
  ...overrides,
});

describe('time zones', () => {
  test('a valid zone passes, an invalid or missing one falls back to the device', () => {
    expect(safeTimeZone('Europe/Oslo')).toBe('Europe/Oslo');
    expect(safeTimeZone('Not/AZone')).toBeUndefined();
    expect(safeTimeZone(undefined)).toBeUndefined();
    expect(whenLabel(NOW - 5 * MINUTE, NOW, 'Not/AZone')).toMatch(/\d{1,2}:\d{2} [AP]M$/);
  });
});

describe('close reasons and kinds', () => {
  test('each close reason has its word', () => {
    expect(closeReasonLabel('sent_reply')).toBe('Replied');
    expect(closeReasonLabel('user_done')).toBe('Done');
    expect(closeReasonLabel('user_done_no_reply')).toBe('Done, no reply sent');
    expect(closeReasonLabel('evidence')).toBe('Closed by itself');
    expect(closeReasonLabel('not_mine')).toBe('Not mine');
    expect(closeReasonLabel('code_used')).toBe('Code used');
    expect(closeReasonLabel('expired')).toBe('Expired');
    expect(closeReasonLabel('event_passed')).toBe('Event started');
    expect(closeReasonLabel('aged_out')).toBe('Closed by itself');
    expect(closeReasonLabel(undefined)).toBe('Closed');
  });

  test('each kind has its word, and a change says when it is time-sensitive', () => {
    expect(kindLabel({ kind: 'reply', pushLevel: 'normal' })).toBe('Reply');
    expect(kindLabel({ kind: 'action', pushLevel: 'normal' })).toBe('Action');
    expect(kindLabel({ kind: 'waiting', pushLevel: 'none' })).toBe('Waiting');
    expect(kindLabel({ kind: 'change', pushLevel: 'normal' })).toBe('Change');
    expect(kindLabel({ kind: 'change', pushLevel: 'time_sensitive' })).toBe('Time-sensitive change');
    expect(kindLabel({ kind: 'code', pushLevel: 'time_sensitive' })).toBe('Code');
    expect(kindLabel({ kind: 'rsvp', pushLevel: 'none' })).toBe('Invitation');
    expect(kindLabel({ kind: 'prepare', pushLevel: 'normal' })).toBe('Prepare');
  });
});

describe('when and how long ago', () => {
  test('today shows the time, yesterday says so, the week shows the weekday, older shows the date', () => {
    expect(whenLabel(NOW - 2 * HOUR, NOW, TZ)).toBe('9:05 AM');
    expect(whenLabel(NOW - DAY, NOW, TZ)).toBe('Yesterday 11:05 AM');
    expect(whenLabel(NOW - 2 * DAY, NOW, TZ)).toBe('Mon 11:05 AM');
    expect(whenLabel(NOW + 2 * DAY, NOW, TZ)).toBe('Fri 11:05 AM');
    expect(whenLabel(NOW - 10 * DAY, NOW, TZ)).toBe('Oct 18');
  });

  test('ago counts minutes, hours, then days', () => {
    expect(agoLabel(NOW - 10_000, NOW)).toBe('just now');
    expect(agoLabel(NOW + 10_000, NOW)).toBe('just now');
    expect(agoLabel(NOW - 2 * MINUTE, NOW)).toBe('2 min ago');
    expect(agoLabel(NOW - 3 * HOUR, NOW)).toBe('3 hr ago');
    expect(agoLabel(NOW - DAY, NOW)).toBe('1 day ago');
    expect(agoLabel(NOW - 3 * DAY, NOW)).toBe('3 days ago');
  });
});

describe('codes', () => {
  test('expiry counts up to the minute, then hours, then says expired', () => {
    expect(expiryLabel(NOW + 8 * MINUTE, NOW)).toBe('8 min');
    expect(expiryLabel(NOW + 7 * MINUTE + 1, NOW)).toBe('8 min');
    expect(expiryLabel(NOW + 65 * MINUTE, NOW)).toBe('1 hr 5 min');
    expect(expiryLabel(NOW + 2 * HOUR, NOW)).toBe('2 hr');
    expect(expiryLabel(NOW, NOW)).toBe('Expired');
  });

  test('the ring shows the share of the life that is left', () => {
    const code = { createdAt: NOW - 2 * MINUTE, code: { value: '1', expiresAt: NOW + 8 * MINUTE } };
    expect(expiryFraction(code, NOW)).toBeCloseTo(0.8);
    expect(expiryFraction(code, NOW + 20 * MINUTE)).toBe(0);
    expect(expiryFraction(code, NOW - 10 * MINUTE)).toBe(1);
    expect(expiryFraction({ createdAt: NOW, code: { value: '1' } }, NOW)).toBe(0);
    expect(expiryFraction({ createdAt: NOW, code: { value: '1', expiresAt: NOW } }, NOW)).toBe(0);
  });

  test('six and eight digits get groups, anything else stays as it is', () => {
    expect(spacedCode('482913')).toBe('482 913');
    expect(spacedCode('482 913')).toBe('482 913');
    expect(spacedCode('12345678')).toBe('1234 5678');
    expect(spacedCode('AB-12')).toBe('AB-12');
    expect(spacedCode('1234567')).toBe('1234567');
  });

  test('the detail sentence names the issuer, or the asker without one', () => {
    expect(obligationSentence(item({ kind: 'code', code: { value: '1', issuer: 'Northwind Bank' } }))).toBe(
      'Verification code from Northwind Bank.',
    );
    expect(obligationSentence(item({ kind: 'code', code: { value: '1' } }))).toBe(
      'Verification code from Ada Example.',
    );
    expect(obligationSentence(item())).toBe('Asks for a reply.');
  });
});

describe('due words', () => {
  test('the due day: today with its time, tomorrow, the weekday, the date', () => {
    expect(dueDayLabel(START_OF_TODAY + 18 * HOUR + 40 * MINUTE, NOW, TZ)).toBe('Today 6:40 PM');
    expect(dueDayLabel(START_OF_TODAY, NOW, TZ)).toBe('Today');
    // A past day is never "Today".
    expect(dueDayLabel(START_OF_TODAY - HOUR, NOW, TZ)).toBe('Yesterday 11:00 PM');
    expect(dueDayLabel(START_OF_TODAY - 3 * DAY + 9 * HOUR, NOW, TZ)).toBe('Oct 25');
    // A parsed due day ends at 23:59:59.999 and shows no time.
    expect(dueDayLabel(START_OF_TODAY + DAY - 1, NOW, TZ)).toBe('Today');
    expect(dueDayLabel(START_OF_TODAY - 1, NOW, TZ)).toBe('Yesterday');
    expect(dueDayLabel(START_OF_TODAY + DAY, NOW, TZ)).toBe('Tomorrow');
    expect(dueDayLabel(START_OF_TODAY + DAY + 9 * HOUR, NOW, TZ)).toBe('Tomorrow 9:00 AM');
    expect(dueDayLabel(START_OF_TODAY + 2 * DAY, NOW, TZ)).toBe('Fri');
    expect(dueDayLabel(START_OF_TODAY + 15 * DAY + 12 * HOUR, NOW, TZ)).toBe('Nov 12');
  });

  test('the due column of a row', () => {
    expect(dueLabel(item({ state: 'done', closeReason: 'user_done_no_reply' }), NOW, TZ)).toEqual({
      text: 'Done, no reply sent',
      tone: 'done',
    });
    expect(dueLabel(item({ kind: 'code', code: { value: '1' } }), NOW, TZ)).toEqual({
      text: '',
      tone: 'plain',
    });
    expect(dueLabel(item({ kind: 'code', code: { value: '1', expiresAt: NOW - 1 } }), NOW, TZ)).toEqual({
      text: 'Expired',
      tone: 'plain',
    });
    expect(
      dueLabel(item({ kind: 'code', code: { value: '1', expiresAt: NOW + 8 * MINUTE } }), NOW, TZ),
    ).toEqual({
      text: '8 min',
      sub: 'expires',
      tone: 'hot',
    });
    expect(dueLabel(item({ kind: 'waiting', createdAt: NOW - HOUR }), NOW, TZ)).toEqual({
      text: 'Today',
      sub: 'waiting',
      tone: 'plain',
    });
    expect(dueLabel(item({ kind: 'waiting', createdAt: NOW - DAY }), NOW, TZ)).toEqual({
      text: '1 day',
      sub: 'waiting',
      tone: 'plain',
    });
    expect(dueLabel(item({ kind: 'waiting', createdAt: NOW - 6 * DAY }), NOW, TZ).text).toBe('6 days');
    expect(
      dueLabel(item({ dueAt: START_OF_TODAY + 18 * HOUR, pushLevel: 'time_sensitive' }), NOW, TZ),
    ).toEqual({
      text: 'Today 6:00 PM',
      tone: 'hot',
    });
    expect(dueLabel(item({ dueAt: START_OF_TODAY + 18 * HOUR }), NOW, TZ).tone).toBe('today');
    expect(dueLabel(item({ dueAt: START_OF_TODAY + 2 * DAY }), NOW, TZ)).toEqual({
      text: 'Fri',
      tone: 'plain',
    });
    expect(dueLabel(item({ due: 'today' }), NOW, TZ)).toEqual({ text: 'Today', tone: 'today' });
    expect(dueLabel(item({ due: 'today', pushLevel: 'time_sensitive' }), NOW, TZ).tone).toBe('hot');
    expect(dueLabel(item({ due: 'soon' }), NOW, TZ)).toEqual({ text: 'Soon', tone: 'plain' });
    expect(dueLabel(item({ due: 'soon', pushLevel: 'time_sensitive' }), NOW, TZ).tone).toBe('hot');
    expect(dueLabel(item({ due: 'later' }), NOW, TZ)).toEqual({ text: 'Later', tone: 'plain' });
    expect(dueLabel(item({ due: 'none' }), NOW, TZ)).toEqual({ text: '', tone: 'plain' });
    expect(dueLabel(item({ due: 'none', pushLevel: 'time_sensitive' }), NOW, TZ).tone).toBe('hot');
  });

  test('the due sentence of the detail source line', () => {
    expect(dueSentence(item({ state: 'done' }), NOW, TZ)).toBe('');
    expect(dueSentence(item({ kind: 'code' }), NOW, TZ)).toBe('');
    expect(dueSentence(item({ kind: 'waiting' }), NOW, TZ)).toBe('');
    expect(dueSentence(item({ dueAt: START_OF_TODAY + 2 * DAY + 17 * HOUR }), NOW, TZ)).toBe('Due Friday');
    expect(dueSentence(item({ dueAt: START_OF_TODAY + DAY }), NOW, TZ)).toBe('Due tomorrow');
    expect(dueSentence(item({ dueAt: START_OF_TODAY + 18 * HOUR }), NOW, TZ)).toBe('Due today 6:00 PM');
    expect(dueSentence(item({ dueAt: START_OF_TODAY + 15 * DAY + 12 * HOUR }), NOW, TZ)).toBe('Due Nov 12');
    expect(dueSentence(item({ due: 'today' }), NOW, TZ)).toBe('Due today');
    expect(dueSentence(item({ due: 'soon' }), NOW, TZ)).toBe('Due soon');
    expect(dueSentence(item({ due: 'later' }), NOW, TZ)).toBe('Due later');
    expect(dueSentence(item({ due: 'none' }), NOW, TZ)).toBe('');
  });
});

describe('the quiet line under the actions', () => {
  test('each kind says what Done does', () => {
    expect(actionNote(item({ kind: 'reply' }))).toContain('Done closes this without a reply');
    expect(actionNote(item({ kind: 'reply', source: 'drive' }))).toBe(
      'Reply in Drive. Done closes this. Undo for 10 seconds.',
    );
    expect(actionNote(item({ kind: 'code' }))).toContain('closes itself when you use the code');
    expect(actionNote(item({ kind: 'waiting' }))).toContain('when the reply arrives');
    expect(actionNote(item({ kind: 'action' }))).toBe('Done closes this. Undo for 10 seconds.');
    expect(actionNote(item({ kind: 'change' }))).toBe('Done closes this. Undo for 10 seconds.');
    expect(actionNote(item({ kind: 'rsvp' }))).toContain('Yes, No, and Maybe answer the invitation');
    expect(actionNote(item({ kind: 'prepare' }))).toContain('closes itself when the event starts');
    expect(
      actionNote(item({ kind: 'action', workId: 'w', workTitle: 'Q3 review deck', asker: 'Priya Raman' })),
    ).toBe(
      'Starts a run in Q3 review deck with Priya Raman’s message as its input. Done closes this. Undo for 10 seconds.',
    );
  });

  test('"Start in Albatross" names the Albatross, or says a new one starts', () => {
    expect(albatrossNote(item({ asker: 'Priya Raman' }))).toBe(
      'Starts a new Albatross with Priya Raman’s message as its input.',
    );
    expect(albatrossNote(item({ asker: 'Priya Raman', workId: 'w', workTitle: ' Q3 review deck ' }))).toBe(
      'Starts a run in Q3 review deck with Priya Raman’s message as its input.',
    );
    expect(albatrossNote(item({ asker: 'Priya Raman', workId: 'w' }))).toBe(
      'Starts a run in the Albatross with Priya Raman’s message as its input.',
    );
    // An event, a meeting, or an issue is not a message.
    expect(albatrossNote(item({ source: 'calendar', workId: 'w', workTitle: 'Deck' }))).toBe(
      'Starts a run in Deck with this event as its input.',
    );
    expect(albatrossNote(item({ source: 'granola' }))).toBe(
      'Starts a new Albatross with this meeting as its input.',
    );
    expect(albatrossNote(item({ source: 'atlassian' }))).toBe(
      'Starts a new Albatross with this issue as its input.',
    );
    expect(albatrossNote(item({ source: 'bitbucket' }))).toBe(
      'Starts a new Albatross with this item as its input.',
    );
    expect(albatrossNote(item({ source: 'slack', asker: 'Priya Raman' }))).toBe(
      'Starts a new Albatross with Priya Raman’s message as its input.',
    );
  });

  test('the toast title is the word on the button', () => {
    expect(actionToastTitle({ action: 'done' })).toBe('Done');
    expect(actionToastTitle({ action: 'later', until: NOW })).toBe('Later');
    expect(actionToastTitle({ action: 'not_mine' })).toBe('Not mine');
    expect(actionToastTitle({ action: 'rsvp', response: 'maybe' })).toBe('Answered maybe');
    expect(actionToastTitle({ action: 'undo' })).toBe('Undone');
  });
});

describe('sources (phase 2)', () => {
  test('the source word, the place in the source, and the open link', () => {
    expect(sourceWord(item())).toBe('Mail');
    expect(sourceWord(item({ source: 'atlassian' }))).toBe('Jira');
    expect(sourceWords(item({ source: 'slack', sourceLabel: '#release' }))).toBe('Slack · #release');
    expect(sourceWords(item({ source: 'github', sourceLabel: '  ' }))).toBe('GitHub');
    expect(openInLabel(item({ source: 'bitbucket' }))).toBe('Open in Bitbucket');
  });

  test('only an https link opens from the app', () => {
    expect(safeSourceUrl(item({ url: 'https://northwind.example.com/x?y=1' }))).toBe(
      'https://northwind.example.com/x?y=1',
    );
    expect(safeSourceUrl(item({ url: 'http://northwind.example.com/x' }))).toBeNull();
    expect(safeSourceUrl(item({ url: 'javascript:alert(1)' }))).toBeNull();
    expect(safeSourceUrl(item({ url: 'not a url' }))).toBeNull();
    expect(safeSourceUrl(item({ url: '  ' }))).toBeNull();
    expect(safeSourceUrl(item())).toBeNull();
  });

  test('the lead: a key for a code, a glyph for a meeting, an issue, a pipeline, or an event, initials otherwise', () => {
    expect(rowLeadKind(item({ kind: 'code' }))).toBe('code');
    expect(rowLeadKind(item({ source: 'granola' }))).toBe('glyph');
    expect(rowLeadKind(item({ source: 'atlassian' }))).toBe('glyph');
    expect(rowLeadKind(item({ source: 'bitbucket' }))).toBe('glyph');
    expect(rowLeadKind(item({ kind: 'prepare', source: 'calendar' }))).toBe('glyph');
    expect(rowLeadKind(item({ kind: 'rsvp', source: 'calendar' }))).toBe('person');
    expect(rowLeadKind(item({ source: 'slack' }))).toBe('person');
    expect(rowLeadKind(item({ source: 'github' }))).toBe('person');
    expect(rowLeadKind(item())).toBe('person');
  });

  test('when the event starts', () => {
    expect(eventStartLabel(item({ eventStart: START_OF_TODAY + DAY + 15 * HOUR }), NOW, TZ)).toBe(
      'Tomorrow 3:00 PM',
    );
    expect(eventStartLabel(item(), NOW, TZ)).toBe('');
  });
});

describe('the first action', () => {
  test('by kind, source, and Albatross', () => {
    expect(primaryAction(item({ kind: 'code' }))).toBe('copy');
    expect(primaryAction(item({ kind: 'reply' }))).toBe('send_reply');
    expect(primaryAction(item({ kind: 'reply', source: 'drive' }))).toBe('done');
    expect(primaryAction(item({ kind: 'reply', source: 'drive', workId: 'w' }))).toBe('start_albatross');
    expect(primaryAction(item({ kind: 'rsvp', source: 'calendar', workId: 'w' }))).toBe('rsvp');
    expect(primaryAction(item({ kind: 'action', workId: 'w' }))).toBe('start_albatross');
    expect(primaryAction(item({ kind: 'action' }))).toBe('done');
    expect(primaryAction(item({ kind: 'prepare', source: 'calendar' }))).toBe('done');
    expect(canSendReply(item({ kind: 'reply' }))).toBe(true);
    expect(canSendReply(item({ kind: 'reply', source: 'slack' }))).toBe(false);
    expect(canStartAlbatross(item({ kind: 'code' }))).toBe(false);
    expect(canStartAlbatross(item({ kind: 'waiting' }))).toBe(true);
  });

  test('the hover pill beside Done', () => {
    expect(primaryPillLabel(item({ kind: 'code' }))).toBe('Copy');
    expect(primaryPillLabel(item({ kind: 'reply' }))).toBe('Reply');
    expect(primaryPillLabel(item({ kind: 'rsvp', source: 'calendar' }))).toBe('Yes');
    expect(primaryPillLabel(item({ kind: 'action', workId: 'w' }))).toBe('Start in Albatross');
    expect(primaryPillLabel(item({ kind: 'action' }))).toBeNull();
  });
});

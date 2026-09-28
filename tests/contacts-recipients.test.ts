import { describe, expect, test } from 'bun:test';
import {
  applyCorrespondentEvents,
  type CorrespondentEvent,
  type CorrespondentStats,
  correspondentEvents,
  correspondentScore,
  correspondentSearchText,
  DEMOTED_SCORE_OFFSET,
  EVENT_WEIGHT,
  eventFrecency,
  FRECENCY_FLOOR,
  FRECENCY_HALF_LIFE_MS,
  frecencyNow,
  groupEventsByEmail,
  isBulkInbound,
  isDemotedCorrespondent,
  logAddExp,
  matchRecipient,
  parseAddressList,
  type RankRecipientsInput,
  rankRecipients,
  withinOneEdit,
} from '../lib/contacts/recipients';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const DAY = 86_400_000;

function person(
  email: string,
  fields: { name?: string; sent?: number[]; received?: number[]; bulk?: number[]; accountId?: string } = {},
): CorrespondentStats {
  const events: CorrespondentEvent[] = [
    ...(fields.sent || []).map((ago) => ({
      email,
      name: fields.name,
      kind: 'sent' as const,
      at: NOW - ago * DAY,
      bulk: false,
      accountId: fields.accountId ?? 'acct_work',
    })),
    ...(fields.received || []).map((ago) => ({
      email,
      name: fields.name,
      kind: 'received' as const,
      at: NOW - ago * DAY,
      bulk: false,
      accountId: fields.accountId ?? 'acct_work',
    })),
    ...(fields.bulk || []).map((ago) => ({
      email,
      name: fields.name,
      kind: 'received' as const,
      at: NOW - ago * DAY,
      bulk: true,
      accountId: fields.accountId ?? 'acct_work',
    })),
  ];
  return applyCorrespondentEvents(null, email, events);
}

function rank(query: string, overrides: Partial<RankRecipientsInput> = {}) {
  return rankRecipients({
    query,
    now: NOW,
    correspondents: [],
    contacts: [],
    selfEmails: ['me@lab86.io', 'me@gmail.com'],
    limit: 8,
    ...overrides,
  });
}

describe('frecency math', () => {
  test('recent sends outweigh old ones, and the stored value orders rows without rewrites', () => {
    const recent = eventFrecency(NOW - DAY, EVENT_WEIGHT.sent);
    const old = eventFrecency(NOW - 200 * DAY, EVENT_WEIGHT.sent);
    expect(recent).toBeGreaterThan(old);
    expect(frecencyNow(recent, NOW)).toBeCloseTo(5 * 2 ** (-1 / 30), 5);
    // One half-life later the value halves.
    expect(frecencyNow(recent, NOW + FRECENCY_HALF_LIFE_MS)).toBeCloseTo(frecencyNow(recent, NOW) / 2, 5);
    expect(frecencyNow(logAddExp(recent, recent), NOW)).toBeCloseTo(2 * frecencyNow(recent, NOW), 5);
    expect(logAddExp(FRECENCY_FLOOR, recent)).toBe(recent);
    expect(logAddExp(recent, FRECENCY_FLOOR)).toBe(recent);
    expect(frecencyNow(undefined, NOW)).toBe(0);
    expect(frecencyNow(FRECENCY_FLOOR, NOW)).toBe(0);
  });
});

describe('mail events', () => {
  const self = new Set(['me@lab86.io']);

  test('address lists split outside quotes and brackets', () => {
    expect(parseAddressList('"Doe, Ann" <ann@x.io>; bob@y.io, Bob <BOB@y.io>, junk, <me@lab86.io>')).toEqual([
      { email: 'ann@x.io', name: 'Doe, Ann' },
      { email: 'bob@y.io' },
      { email: 'me@lab86.io' },
    ]);
    expect(parseAddressList(undefined)).toEqual([]);
  });

  test('sent mail counts each other recipient; received mail counts the sender', () => {
    const sent = correspondentEvents(
      {
        from: 'Me <me@lab86.io>',
        to: 'Ann Lee <ann@acme.com>, me@lab86.io',
        cc: 'bob@acme.com',
        bcc: 'ann@acme.com',
        receivedAt: NOW,
        labels: ['SENT'],
      },
      'acct',
      self,
    );
    expect(sent).toEqual([
      { email: 'ann@acme.com', name: 'Ann Lee', kind: 'sent', at: NOW, bulk: false, accountId: 'acct' },
      { email: 'bob@acme.com', kind: 'sent', at: NOW, bulk: false, accountId: 'acct' },
    ]);
    const received = correspondentEvents(
      { from: 'News <news@shop.example>', receivedAt: NOW, headers: { 'List-Unsubscribe': '<mailto:x>' } },
      'acct',
      self,
    );
    expect(received).toEqual([
      // "News" only repeats the local part, so it is not a name.
      { email: 'news@shop.example', kind: 'received', at: NOW, bulk: true, accountId: 'acct' },
    ]);
  });

  test('drafts, spam, trash, and rows without a time or sender give nothing', () => {
    for (const labels of [['DRAFT'], ['SPAM'], ['TRASH']]) {
      expect(correspondentEvents({ from: 'a@b.io', receivedAt: NOW, labels }, 'acct', self)).toEqual([]);
    }
    expect(correspondentEvents({ from: 'a@b.io', receivedAt: 0 }, 'acct', self)).toEqual([]);
    expect(correspondentEvents({ from: 'nobody', receivedAt: NOW }, 'acct', self)).toEqual([]);
  });

  test('bulk signals', () => {
    expect(isBulkInbound({ from: 'a@b.io', headers: { 'list-id': 'x' } })).toBe(true);
    expect(isBulkInbound({ from: 'a@b.io', headers: { precedence: 'bulk' } })).toBe(true);
    expect(isBulkInbound({ from: 'a@b.io', headers: { 'auto-submitted': 'auto-generated' } })).toBe(true);
    expect(isBulkInbound({ from: 'a@b.io', headers: { 'auto-submitted': 'no' } })).toBe(false);
    expect(isBulkInbound({ from: 'a@b.io', headers: { 'x-campaign-id': '1' } })).toBe(true);
    expect(isBulkInbound({ from: 'notifications@github.com' })).toBe(true);
    expect(isBulkInbound({ from: 'a@b.io', labels: ['CATEGORY_PROMOTIONS'] })).toBe(true);
    expect(isBulkInbound({ from: 'Ann <a@b.io>', headers: { 'list-id': '' }, labels: ['INBOX'] })).toBe(
      false,
    );
  });

  test('rows add up events, keep the newest name, and cap mailbox stats', () => {
    const events: CorrespondentEvent[] = [
      { email: 'a@x.io', name: 'Old Name', kind: 'received', at: 1_000, bulk: false, accountId: 'one' },
      { email: 'a@x.io', name: 'New Name', kind: 'sent', at: 3_000, bulk: false, accountId: 'two' },
      { email: 'a@x.io', kind: 'received', at: 2_000, bulk: true, accountId: 'one' },
    ];
    const row = applyCorrespondentEvents(null, 'a@x.io', events);
    expect(row).toMatchObject({
      name: 'New Name',
      sentCount: 1,
      receivedCount: 2,
      bulkCount: 1,
      lastSentAt: 3_000,
      lastReceivedAt: 2_000,
    });
    expect(row.accounts).toEqual([
      { accountId: 'two', sent: 1, received: 0, lastAt: 3_000 },
      { accountId: 'one', sent: 0, received: 2, lastAt: 2_000 },
    ]);
    const again = applyCorrespondentEvents(row, 'a@x.io', [
      { email: 'a@x.io', kind: 'sent', at: 4_000, bulk: false, accountId: 'two' },
    ]);
    expect(again.sentCount).toBe(2);
    expect(again.frecency).toBeGreaterThan(row.frecency);
    expect(row.sentCount).toBe(1);
    const many = applyCorrespondentEvents(
      null,
      'b@x.io',
      Array.from({ length: 12 }, (_, i) => ({
        email: 'b@x.io',
        kind: 'received' as const,
        at: i + 1,
        bulk: false,
        accountId: `acct${i}`,
      })),
    );
    expect(many.accounts).toHaveLength(10);
    expect(groupEventsByEmail(events).get('a@x.io')).toHaveLength(3);
    expect(correspondentSearchText('ann.lee@acme.com', 'Ann Lee')).toBe('ann lee ann lee acme com');
  });

  test('demotion: bulk or automated senders the user never wrote to', () => {
    const bulk = person('deals@shop.example', { bulk: [1, 2, 3] });
    expect(isDemotedCorrespondent(bulk)).toBe(true);
    expect(correspondentScore(bulk)).toBe(bulk.frecency - DEMOTED_SCORE_OFFSET);
    expect(isDemotedCorrespondent(person('noreply@x.io', { received: [1] }))).toBe(true);
    expect(isDemotedCorrespondent(person('deals@shop.example', { bulk: [1], sent: [2] }))).toBe(false);
    expect(isDemotedCorrespondent(person('ann@acme.com', { received: [1, 2], bulk: [3] }))).toBe(false);
  });
});

describe('matching', () => {
  test('name words, local part, initials, domain, typo, and substring', () => {
    const jakob = { name: 'Jakob Langtry', email: 'jakob@lab86.io' };
    expect(matchRecipient('jak', jakob)).toMatchObject({
      strength: 3,
      precision: 5,
      highlights: [{ field: 'name', start: 0, length: 3 }],
    });
    expect(matchRecipient('lang', jakob)).toMatchObject({ strength: 3, precision: 0 });
    expect(matchRecipient('lang jak', jakob).highlights).toEqual([
      { field: 'name', start: 6, length: 4 },
      { field: 'name', start: 0, length: 3 },
    ]);
    expect(matchRecipient('jl', jakob)).toMatchObject({
      strength: 3,
      highlights: [
        { field: 'name', start: 0, length: 1 },
        { field: 'name', start: 6, length: 1 },
      ],
    });
    expect(matchRecipient('JAKOB@', { email: 'jakob@lab86.io' })).toMatchObject({
      strength: 3,
      highlights: [{ field: 'email', start: 0, length: 6 }],
    });
    expect(matchRecipient('lab8', jakob)).toMatchObject({
      strength: 2,
      highlights: [{ field: 'email', start: 6, length: 4 }],
    });
    expect(matchRecipient('@lab', jakob).strength).toBe(2);
    expect(matchRecipient('jkaob', jakob).strength).toBe(2);
    expect(matchRecipient('langtyr', jakob).strength).toBe(2);
    expect(matchRecipient('jako', { email: 'jkao.b@x.io' }).strength).toBe(2);
    expect(matchRecipient('jak', { email: 'x@y.io' }).strength).toBe(0);
    // A missing first letter is one edit.
    expect(matchRecipient('akob', jakob).strength).toBe(2);
    expect(matchRecipient('kob', jakob)).toMatchObject({
      strength: 1,
      highlights: [{ field: 'email', start: 2, length: 3 }],
    });
    expect(matchRecipient('obla', { name: 'Jakob Langtry', email: 'j@x.io' }).strength).toBe(1);
    // Typo tolerance needs four or more characters.
    expect(matchRecipient('jkb', jakob).strength).toBe(0);
    expect(matchRecipient('  ', jakob).strength).toBe(0);
    expect(matchRecipient('José', { name: 'Jose Ruiz', email: 'j@x.io' }).strength).toBe(3);
    expect(matchRecipient('mas', { name: 'Mary Ann Smith', email: 'm@x.io' }).strength).toBe(3);
    expect(matchRecipient('ms', { name: 'Mary Ann Smith', email: 'm@x.io' }).strength).toBe(3);
  });

  test('one edit', () => {
    expect(withinOneEdit('jakob', 'jakob')).toBe(true);
    expect(withinOneEdit('jkaob', 'jakob')).toBe(true);
    expect(withinOneEdit('jakxb', 'jakob')).toBe(true);
    expect(withinOneEdit('jakb', 'jakob')).toBe(true);
    expect(withinOneEdit('jakoob', 'jakob')).toBe(true);
    expect(withinOneEdit('jxkxb', 'jakob')).toBe(false);
    expect(withinOneEdit('ja', 'jakob')).toBe(false);
  });
});

describe('rankRecipients', () => {
  test('frecency orders people with an equal match', () => {
    const items = rank('an', {
      correspondents: [
        person('anne@old.example', { name: 'Anne Old', sent: [300, 310, 320] }),
        person('andy@acme.com', { name: 'Andy Now', sent: [1, 2] }),
        person('ana@acme.com', { name: 'Ana Heard', received: [1] }),
      ],
    });
    expect(items.map((item) => item.email)).toEqual(['andy@acme.com', 'ana@acme.com', 'anne@old.example']);
    expect(items[0]).toMatchObject({ sources: ['mail'], sentCount: 2, lastContactedAt: NOW - DAY });
  });

  test('bulk and no-reply senders never come first', () => {
    const items = rank('a', {
      correspondents: [
        person('alerts@bank.example', { bulk: [0, 0, 0, 1, 1, 1, 2, 2] }),
        person('noreply@app.example', { received: [0, 0, 0] }),
        person('amy@acme.com', { name: 'Amy', received: [200] }),
      ],
    });
    expect(items[0].email).toBe('amy@acme.com');
    expect(items.slice(1).every((item) => item.score < 0)).toBe(true);
  });

  test('one item for each person: a saved contact collapses its addresses', () => {
    const items = rank('ann', {
      correspondents: [
        person('ann@acme.com', { name: 'ann', sent: [1] }),
        person('ann@home.example', { received: [2] }),
      ],
      contacts: [
        {
          id: 'c1',
          accountId: 'acct_work',
          source: 'address_book',
          name: 'Ann Lee',
          emails: ['ann@home.example', 'ann@acme.com'],
          company: 'Acme',
        },
        { id: 'c2', accountId: 'acct_work', source: 'inbox', name: 'A.', emails: ['ann@acme.com'] },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      email: 'ann@acme.com',
      name: 'Ann Lee',
      alternateEmails: ['ann@home.example'],
      savedContact: true,
      sources: ['addressBook', 'inbox', 'mail'],
      company: 'Acme',
      sentCount: 1,
      receivedCount: 1,
    });
  });

  test('two contacts that share an address merge into one person', () => {
    const items = rank('bo', {
      contacts: [
        { id: 'c1', accountId: 'a', source: 'address_book', name: 'Bo One', emails: ['bo@x.io'] },
        { id: 'c2', accountId: 'b', source: 'address_book', name: 'Bo Two', emails: ['bo2@x.io'] },
        {
          id: 'c3',
          accountId: 'b',
          source: 'address_book',
          name: 'Bo Both',
          emails: ['bo@x.io', 'bo2@x.io'],
        },
        {
          id: 'c4',
          accountId: 'b',
          source: 'domain',
          name: 'Bo Dir',
          emails: ['bo3@x.io'],
          jobTitle: 'Lead',
        },
      ],
    });
    expect(items.map((item) => item.email).sort()).toEqual(['bo3@x.io', 'bo@x.io']);
    expect(items.find((item) => item.email === 'bo3@x.io')).toMatchObject({
      directory: true,
      jobTitle: 'Lead',
    });
  });

  test('initials and a typo find the person', () => {
    const correspondents = [person('jakob@lab86.io', { name: 'Jakob Langtry', sent: [1] })];
    expect(rank('jl', { correspondents })[0].email).toBe('jakob@lab86.io');
    expect(rank('jkaob', { correspondents })[0].email).toBe('jakob@lab86.io');
    expect(rank('zzz', { correspondents })).toEqual([]);
  });

  test('a typed complete address is always first, known or not', () => {
    const correspondents = [
      person('ann@acme.com', { name: 'Ann', sent: [1, 1, 1, 1] }),
      person('ann@acme.co', { name: 'Ann Co', received: [300] }),
    ];
    const known = rank('ann@acme.co', { correspondents });
    expect(known[0]).toMatchObject({ email: 'ann@acme.co', sources: ['mail'] });
    const unknown = rank('new.person@acme.com', { correspondents });
    expect(unknown[0]).toMatchObject({ email: 'new.person@acme.com', sources: ['typed'] });
    expect(
      rank('ann@acme.com', { correspondents, exclude: ['ann@acme.com'] }).map((item) => item.email),
    ).toEqual([]);
  });

  test("the user's own addresses come back only when typed exactly", () => {
    const correspondents = [person('me@lab86.io', { name: 'Me', received: [1] })];
    expect(rank('me', { correspondents })).toEqual([]);
    expect(rank('me@lab86.io', { correspondents })[0].email).toBe('me@lab86.io');
    expect(rank('', { correspondents })).toEqual([]);
  });

  test('the From mailbox, a saved contact, the directory, and the work domain add points', () => {
    const correspondents = [
      person('pat@personal.example', { name: 'Pat Home', received: [5], accountId: 'acct_home' }),
      person('pam@other.example', { name: 'Pam Work', received: [5], accountId: 'acct_work' }),
    ];
    expect(rank('pa', { correspondents, fromAccountId: 'acct_home' })[0].email).toBe('pat@personal.example');
    expect(rank('pa', { correspondents, fromAccountId: 'acct_work' })[0].email).toBe('pam@other.example');
    const sameDomain = rank('pa', {
      correspondents: [
        person('pat@personal.example', { name: 'Pat Home', received: [5] }),
        person('pam@lab86.io', { name: 'Pam Work', received: [5] }),
      ],
      workDomains: ['lab86.io'],
    });
    expect(sameDomain[0].email).toBe('pam@lab86.io');
    const contactFromAccount = rank('pa', {
      contacts: [
        { id: '1', accountId: 'acct_a', source: 'inbox', name: 'Pat A', emails: ['pat@a.example'] },
        { id: '2', accountId: 'acct_b', source: 'inbox', name: 'Pat B', emails: ['pat@b.example'] },
      ],
      fromAccountId: 'acct_b',
    });
    expect(contactFromAccount[0].email).toBe('pat@b.example');
  });

  test('an empty query lists recent people, most frecent first, without excluded ones', () => {
    const items = rank('', {
      correspondents: [
        person('old@x.io', { sent: [400] }),
        person('new@x.io', { sent: [0, 1] }),
        person('mid@x.io', { received: [3] }),
      ],
      contacts: [{ id: 'c', accountId: 'a', source: 'address_book', name: 'Quiet', emails: ['quiet@x.io'] }],
      exclude: ['mid@x.io'],
      limit: 5,
    });
    expect(items.map((item) => item.email)).toEqual(['new@x.io', 'old@x.io']);
    expect(items[0].highlights).toEqual([]);
  });

  test('the limit holds and ties break by recent contact then address', () => {
    const correspondents = Array.from({ length: 12 }, (_, i) =>
      person(`p${i}@x.io`, { name: `Pat ${i}`, received: [5] }),
    );
    const items = rank('pat', { correspondents, limit: 3 });
    expect(items.map((item) => item.email)).toEqual(['p0@x.io', 'p1@x.io', 'p10@x.io']);
    expect(rank('pat', { correspondents, limit: 0 })).toHaveLength(1);
  });
});

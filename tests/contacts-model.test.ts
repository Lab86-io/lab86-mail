import { describe, expect, test } from 'bun:test';
import {
  activityScore,
  buildContactSearchText,
  type ContactCandidate,
  contactScopeState,
  contactSourcePlan,
  expandAliasFromCandidates,
  isConsumerMailbox,
  isWeakHeaderName,
  matchTier,
  normalizeContactEmail,
  normalizeNylasContact,
  normalizeSearchText,
  preferredSenderName,
  rankContactCandidates,
  stableHash,
} from '../lib/contacts/model';

const G = 'https://www.googleapis.com/auth/';

describe('contact scopes', () => {
  test('Google sources follow the granted scopes', () => {
    const account = {
      provider: 'google' as const,
      email: 'ann@acme.com',
      scopes: [`${G}gmail.modify`, `${G}contacts.readonly`],
    };
    expect(contactScopeState(account, 'address_book')).toBe('granted');
    expect(contactScopeState(account, 'inbox')).toBe('missing');
    expect(contactScopeState(account, 'domain')).toBe('missing');
    expect(
      contactScopeState({ ...account, scopes: [`${G}contacts`, `${G}contacts.other.readonly`] }, 'inbox'),
    ).toBe('granted');
    expect(contactScopeState({ ...account, scopes: [`${G}contacts`] }, 'address_book')).toBe('granted');
    expect(contactScopeState({ ...account, scopes: [`${G}directory.readonly`] }, 'domain')).toBe('granted');
  });

  test('an empty scope list and a Microsoft .default request are unknown, not missing', () => {
    expect(contactScopeState({ provider: 'google', scopes: [] }, 'address_book')).toBe('unknown');
    const microsoft = {
      provider: 'microsoft' as const,
      email: 'ann@contoso.com',
      scopes: ['https://graph.microsoft.com/.default', 'https://graph.microsoft.com/Mail.ReadWrite'],
    };
    expect(contactScopeState(microsoft, 'address_book')).toBe('unknown');
    expect(
      contactScopeState(
        { ...microsoft, scopes: ['https://graph.microsoft.com/Contacts.Read', 'People.Read'] },
        'address_book',
      ),
    ).toBe('granted');
    expect(contactScopeState({ ...microsoft, scopes: ['People.Read'] }, 'domain')).toBe('granted');
    expect(contactScopeState({ ...microsoft, scopes: ['Mail.Read'] }, 'inbox')).toBe('missing');
  });

  test('iCloud reads only the address book, IMAP asks, and consumer mail has no directory', () => {
    expect(contactScopeState({ provider: 'icloud', scopes: [] }, 'address_book')).toBe('granted');
    expect(contactScopeState({ provider: 'icloud', scopes: [] }, 'inbox')).toBe('unsupported');
    expect(contactScopeState({ provider: 'icloud', scopes: [] }, 'domain')).toBe('unsupported');
    expect(contactScopeState({ provider: 'imap', scopes: [] }, 'address_book')).toBe('unknown');
    expect(contactScopeState({ provider: 'imap', scopes: [] }, 'inbox')).toBe('unsupported');
    expect(
      contactScopeState(
        { provider: 'google', email: 'ann@gmail.com', scopes: [`${G}directory.readonly`] },
        'domain',
      ),
    ).toBe('unsupported');
    expect(isConsumerMailbox('Ann@Outlook.com')).toBe(true);
    expect(isConsumerMailbox('ann@acme.com')).toBe(false);
    expect(isConsumerMailbox(undefined)).toBe(false);
    expect(contactSourcePlan({ provider: 'icloud', scopes: [] }).map((entry) => entry.source)).toEqual([
      'address_book',
      'inbox',
      'domain',
    ]);
  });
});

describe('normalizeNylasContact', () => {
  test('keeps a small row with clean fields and a stable hash', () => {
    const contact = normalizeNylasContact(
      {
        id: 'c1',
        source: 'address_book',
        givenName: 'Ann',
        surname: 'Lee',
        emails: [
          { email: 'Ann.Lee@Acme.com', type: 'work' },
          { email: 'ann.lee@acme.com' },
          { email: 'not an email' },
          'ann@home.example',
        ],
        phoneNumbers: [{ number: '+1 555 0100', type: 'mobile' }, { number: '' }],
        companyName: 'Acme',
        jobTitle: 'Engineer',
        pictureUrl: 'https://photos.example/ann.png',
        groups: [{ id: 'g1', name: 'Friends' }, { id: 'g2' }, { id: 'g1', name: 'Friends' }],
      },
      'inbox',
    );
    expect(contact).toMatchObject({
      providerContactId: 'c1',
      source: 'address_book',
      displayName: 'Ann Lee',
      givenName: 'Ann',
      familyName: 'Lee',
      emails: [{ email: 'ann.lee@acme.com', type: 'work' }, { email: 'ann@home.example' }],
      phones: [{ number: '+1 555 0100', type: 'mobile' }],
      company: 'Acme',
      jobTitle: 'Engineer',
      photoUrl: 'https://photos.example/ann.png',
      groups: ['Friends', 'g2'],
    });
    expect(contact?.searchText).toContain('ann lee');
    expect(contact?.searchText).toContain('acme com');
    const again = normalizeNylasContact(
      {
        id: 'c1',
        source: 'address_book',
        given_name: 'Ann',
        surname: 'Lee',
        emails: [{ email: 'ann.lee@acme.com', type: 'work' }, { email: 'ann@home.example' }],
        phone_numbers: [{ number: '+1 555 0100', type: 'mobile' }],
        company_name: 'Acme',
        job_title: 'Engineer',
        picture_url: 'https://photos.example/ann.png',
        groups: [{ name: 'Friends' }, { id: 'g2' }],
      },
      'inbox',
    );
    expect(again?.contentHash).toBe(contact?.contentHash);
  });

  test('drops cards without an address, bad photo links, and address display names', () => {
    expect(
      normalizeNylasContact({ id: 'c2', displayName: 'Phone only', emails: [] }, 'address_book'),
    ).toBeNull();
    expect(normalizeNylasContact({ emails: [{ email: 'a@b.co' }] }, 'address_book')).toBeNull();
    expect(normalizeNylasContact(null, 'address_book')).toBeNull();
    const contact = normalizeNylasContact(
      {
        id: 'c3',
        displayName: 'bob@example.com',
        nickname: 'Bobby',
        emails: [{ email: 'bob@example.com' }],
        pictureUrl: 'data:image/png;base64,AAAA',
        source: 'weird',
      },
      'domain',
    );
    expect(contact?.displayName).toBe('Bobby');
    expect(contact?.photoUrl).toBeUndefined();
    expect(contact?.source).toBe('domain');
  });

  test('a changed field changes the hash', () => {
    const base = { id: 'c4', displayName: 'Cy', emails: [{ email: 'cy@example.com' }] };
    const one = normalizeNylasContact(base, 'address_book');
    const two = normalizeNylasContact({ ...base, jobTitle: 'Lead' }, 'address_book');
    expect(one?.contentHash).not.toBe(two?.contentHash);
    expect(stableHash('a')).not.toBe(stableHash('b'));
    expect(stableHash('abc')).toHaveLength(16);
  });

  test('search text and emails normalize', () => {
    expect(normalizeSearchText('José O’Brien <JOSE@ex.com>')).toBe('jose o brien jose ex com');
    expect(normalizeSearchText(undefined)).toBe('');
    expect(normalizeContactEmail(' A@B.CO ')).toBe('a@b.co');
    expect(normalizeContactEmail('nope')).toBeNull();
    expect(normalizeContactEmail(42)).toBeNull();
    expect(buildContactSearchText({ displayName: 'Dee', emails: [{ email: 'dee@x.io' }] })).toBe(
      'dee dee x io',
    );
  });
});

describe('sender names', () => {
  test('a weak header name is a bare address or a repeat of the local part', () => {
    expect(isWeakHeaderName('ann@acme.com')).toBe(true);
    expect(isWeakHeaderName('<ann@acme.com>')).toBe(true);
    expect(isWeakHeaderName('"ann.lee" <ann.lee@acme.com>')).toBe(true);
    expect(isWeakHeaderName('ann@acme.com <ann@acme.com>')).toBe(true);
    expect(isWeakHeaderName('Ann Lee <ann@acme.com>')).toBe(false);
    expect(isWeakHeaderName('Ann Lee')).toBe(false);
    expect(isWeakHeaderName('')).toBe(true);
  });

  test('a saved name replaces only a weak header name', () => {
    expect(preferredSenderName('ann@acme.com', 'Ann Lee')).toBe('Ann Lee');
    expect(preferredSenderName('Annie <ann@acme.com>', 'Ann Lee')).toBeUndefined();
    expect(preferredSenderName('ann@acme.com', 'ann@acme.com')).toBeUndefined();
    expect(preferredSenderName('ann@acme.com', undefined)).toBeUndefined();
  });
});

describe('ranking', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const saved: ContactCandidate = {
    source: 'address_book',
    name: 'Ann Lee',
    givenName: 'Ann',
    emails: ['ann@acme.com'],
  };
  const directory: ContactCandidate = { source: 'domain', name: 'Anna Park', emails: ['anna@acme.com'] };
  const inbox: ContactCandidate = { source: 'inbox', emails: ['annika@shop.example'] };

  test('match tiers', () => {
    expect(matchTier('ann@acme.com', saved, 'ann@acme.com')).toBe(5);
    expect(matchTier('Ann Lee', saved, 'ann@acme.com')).toBe(5);
    expect(matchTier('ann', saved, 'ann@acme.com')).toBe(4);
    expect(matchTier('lee', saved, 'ann@acme.com')).toBe(3);
    expect(matchTier('nnle', saved, 'ann@acme.com')).toBe(2);
    expect(matchTier('acm', { source: 'inbox', company: 'Acme', emails: ['x@y.z'] }, 'x@y.z')).toBe(1);
    expect(matchTier('zed', saved, 'ann@acme.com')).toBe(0);
    expect(matchTier('  ', saved, 'ann@acme.com')).toBe(0);
  });

  test('match quality, then source, then recent mail', () => {
    const ranked = rankContactCandidates('ann', [inbox, directory, saved], new Map(), { now });
    // Equal match quality: people the user wrote to rank above the directory.
    expect(ranked.map((entry) => entry.email)).toEqual([
      'ann@acme.com',
      'annika@shop.example',
      'anna@acme.com',
    ]);
    const activity = new Map([['anna@acme.com', { lastAt: now - 1_000, count: 12 }]]);
    const withMail = rankContactCandidates(
      'an',
      [directory, { ...saved, emails: ['annl@acme.com'] }],
      activity,
      {
        now,
      },
    );
    expect(withMail[0].email).toBe('annl@acme.com');
    expect(withMail[1]).toMatchObject({ email: 'anna@acme.com', count: 12 });
  });

  test('one row for each address keeps the best source and the saved name', () => {
    const recent: ContactCandidate = { source: 'recent', emails: ['ann@acme.com'] };
    const ranked = rankContactCandidates('ann', [recent, saved], new Map(), { now });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ source: 'address_book', name: 'Ann Lee' });
    const reversed = rankContactCandidates('ann', [saved, { ...recent, name: undefined }], new Map(), {
      now,
    });
    expect(reversed[0].name).toBe('Ann Lee');
    expect(rankContactCandidates('ann', [{ source: 'inbox', emails: ['ann@acme.com'] }, recent]).length).toBe(
      1,
    );
  });

  test('activity points', () => {
    expect(activityScore(undefined)).toBe(0);
    expect(activityScore({ lastAt: now - 2 * 86_400_000, count: 10 }, now)).toBe(9);
    expect(activityScore({ lastAt: now - 20 * 86_400_000, count: 3 }, now)).toBe(5);
    expect(activityScore({ lastAt: now - 100 * 86_400_000, count: 1 }, now)).toBe(2);
    expect(activityScore({ count: 0 }, now)).toBe(0);
  });
});

describe('expandAliasFromCandidates', () => {
  const ann: ContactCandidate = {
    source: 'address_book',
    name: 'Ann Lee',
    givenName: 'Ann',
    emails: ['ann@acme.com'],
  };
  test('one person answers; the same person in two sources is still one', () => {
    expect(expandAliasFromCandidates('ann', [ann])).toEqual({
      email: 'ann@acme.com',
      displayName: 'Ann Lee',
      candidates: [],
    });
    const sameInInbox: ContactCandidate = { source: 'inbox', name: 'Ann', emails: ['ann@acme.com'] };
    expect(expandAliasFromCandidates('Ann', [sameInInbox, ann]).email).toBe('ann@acme.com');
    expect(expandAliasFromCandidates('ann lee', [ann]).displayName).toBe('Ann Lee');
  });

  test('two people give candidates and no address', () => {
    const other: ContactCandidate = { source: 'domain', name: 'Ann Park', emails: ['apark@acme.com'] };
    const result = expandAliasFromCandidates('ann', [ann, other]);
    expect(result.email).toBeNull();
    expect(result.candidates.map((entry) => entry.email).sort()).toEqual(['ann@acme.com', 'apark@acme.com']);
  });

  test('a better match level wins over weaker ones, and an address passes through', () => {
    const local: ContactCandidate = { source: 'inbox', emails: ['ann.smith@shop.example'] };
    expect(expandAliasFromCandidates('ann lee', [ann, local]).email).toBe('ann@acme.com');
    expect(expandAliasFromCandidates('ann.smith', [local]).email).toBe('ann.smith@shop.example');
    expect(expandAliasFromCandidates('ann@acme.com', [ann])).toEqual({
      email: 'ann@acme.com',
      displayName: 'Ann Lee',
      candidates: [],
    });
    expect(expandAliasFromCandidates('zed', [ann])).toEqual({ email: null, candidates: [] });
    expect(expandAliasFromCandidates('   ', [ann])).toEqual({ email: null, candidates: [] });
  });
});

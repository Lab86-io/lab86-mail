import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { normalizeNylasContact } from '../lib/contacts/model';
import { __resetContactsAdapterCacheForTest, googleContactsAdapter } from '../lib/google/adapter/contacts';
import {
  contactIdFromResourceName,
  resourceNameFromContactId,
  sourceForContactId,
} from '../lib/google/contacts-map';
import { __setGoogleHttpDepsForTest, GoogleApiError } from '../lib/google/http';

// People API fixtures follow the real JSON of Google accounts (resource
// names, photo hosts, membership and email types) with invented people.

const GRANT = 'google:acct-1';

interface Call {
  method: string;
  url: URL;
}

type Reply = { status?: number; json?: unknown };

function google() {
  const calls: Call[] = [];
  const routes: Array<{ pattern: RegExp; reply: (call: Call) => Reply }> = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const call: Call = { method: init?.method || 'GET', url: new URL(input) };
    calls.push(call);
    const route = routes.find((entry) => entry.pattern.test(call.url.pathname));
    const reply = route
      ? route.reply(call)
      : { status: 404, json: { error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } } };
    return new Response(reply.json === undefined ? null : JSON.stringify(reply.json), {
      status: reply.status ?? 200,
    });
  };
  __setGoogleHttpDepsForTest({
    fetch,
    getGoogleAccessToken: async () => 'token',
    invalidateGoogleAccessToken: () => {},
    sleep: async () => {},
  });
  return {
    calls,
    on(pattern: RegExp, reply: Reply | ((call: Call) => Reply)) {
      routes.push({ pattern, reply: typeof reply === 'function' ? reply : () => reply });
    },
  };
}

const adapter = googleContactsAdapter.contacts!;

beforeEach(() => __resetContactsAdapterCacheForTest());
afterEach(() => __setGoogleHttpDepsForTest());

const savedContact = {
  resourceName: 'people/c6993101230118454048',
  etag: '%EgUBAgMuNxo',
  names: [
    { metadata: { primary: true }, displayName: 'Bea Marsh', givenName: 'Bea', familyName: 'Marsh' },
    { displayName: 'B. Marsh' },
  ],
  nicknames: [{ value: 'Bee' }],
  emailAddresses: [
    { metadata: { primary: true }, value: 'bea@plug.example.test', type: 'home' },
    { value: '' },
  ],
  phoneNumbers: [{ value: '+1 555 0100', type: 'mobile' }],
  photos: [
    { metadata: { primary: true }, url: 'https://lh3.googleusercontent.com/cm/AGPWSu_K2', default: true },
  ],
  organizations: [{ name: 'Plug', title: 'Engineer' }],
  memberships: [
    {
      contactGroupMembership: {
        contactGroupId: 'myContacts',
        contactGroupResourceName: 'contactGroups/myContacts',
      },
    },
    { domainMembership: { inViewerDomain: true } },
  ],
};

const otherContact = {
  resourceName: 'otherContacts/c2285657842241455500',
  emailAddresses: [
    { metadata: { primary: true, source: { type: 'OTHER_CONTACT' } }, value: 'ops@cardhunt.example.test' },
  ],
  photos: [
    {
      metadata: { source: { type: 'OTHER_CONTACT' } },
      url: 'https://lh3.googleusercontent.com/cm/AGPWSu9',
      default: true,
    },
    {
      metadata: { primary: true, source: { type: 'PROFILE' } },
      url: 'https://lh3.googleusercontent.com/a-/ALV-Uj',
    },
  ],
};

const directoryPerson = {
  resourceName: 'people/112500239746871362125',
  names: [{ displayName: 'Mia Stone', givenName: 'Mia', familyName: 'Stone' }],
  emailAddresses: [
    { metadata: { primary: true }, value: 'mia@work.example.test' },
    { value: 'mia.stone@gmail.example.test', type: 'work' },
  ],
  phoneNumbers: [{ value: '555-0101', type: 'work' }],
  photos: [{ url: 'https://lh3.googleusercontent.com/a/ACg8oc' }],
};

describe('contacts.list by source', () => {
  test('address_book reads saved contacts with Nylas ids and fields', async () => {
    const g = google();
    g.on(/\/people\/me\/connections$/, (call) =>
      call.url.searchParams.get('pageToken')
        ? { json: { totalPeople: 1 } }
        : { json: { connections: [savedContact], nextPageToken: 'p2', totalPeople: 1 } },
    );
    const first = await adapter.list({
      identifier: GRANT,
      queryParams: { source: 'address_book', limit: 100 },
    });
    const params = g.calls[0].url.searchParams;
    expect(params.get('personFields')).toBe(
      'names,nicknames,emailAddresses,phoneNumbers,photos,organizations,memberships',
    );
    expect(params.get('pageSize')).toBe('100');
    expect(first.nextCursor).toBe('p2');
    expect(first.data).toEqual([
      {
        id: 'c6993101230118454048',
        grantId: GRANT,
        object: 'contact',
        source: 'address_book',
        displayName: 'Bea Marsh',
        givenName: 'Bea',
        surname: 'Marsh',
        nickname: 'Bee',
        emails: [{ email: 'bea@plug.example.test', type: 'home' }],
        phoneNumbers: [{ number: '+1 555 0100', type: 'mobile' }],
        pictureUrl: 'https://lh3.googleusercontent.com/cm/AGPWSu_K2',
        companyName: 'Plug',
        jobTitle: 'Engineer',
        groups: [{ id: 'myContacts', object: 'contact_group' }],
        imAddresses: [],
        physicalAddresses: [],
        webPages: [],
      },
    ]);
    // The stored row matches the row that Nylas produced for this contact.
    expect(normalizeNylasContact(first.data[0], 'address_book')).toMatchObject({
      providerContactId: 'c6993101230118454048',
      source: 'address_book',
      displayName: 'Bea Marsh',
      givenName: 'Bea',
      familyName: 'Marsh',
      emails: [{ email: 'bea@plug.example.test', type: 'home' }],
      phones: [{ number: '+1 555 0100', type: 'mobile' }],
      groups: ['myContacts'],
      photoUrl: 'https://lh3.googleusercontent.com/cm/AGPWSu_K2',
    });

    const second = await adapter.list({
      identifier: GRANT,
      queryParams: { source: 'address_book', limit: 100, pageToken: 'p2' },
    });
    expect(second.data).toEqual([]);
    expect(second.nextCursor).toBeUndefined();
    expect(g.calls[1].url.searchParams.get('pageToken')).toBe('p2');
  });

  test('inbox reads other contacts with profile data and keeps the full id', async () => {
    const g = google();
    g.on(/\/otherContacts$/, { json: { otherContacts: [otherContact] } });
    const page = await adapter.list({ identifier: GRANT, queryParams: { source: 'inbox', limit: 5000 } });
    const params = g.calls[0].url.searchParams;
    expect(params.get('readMask')).toBe('names,emailAddresses,phoneNumbers,photos');
    expect(params.getAll('sources')).toEqual(['READ_SOURCE_TYPE_CONTACT', 'READ_SOURCE_TYPE_PROFILE']);
    expect(params.get('pageSize')).toBe('1000');
    const [contact] = page.data as any[];
    expect(contact.id).toBe('otherContacts/c2285657842241455500');
    expect(contact.source).toBe('inbox');
    expect(contact.pictureUrl).toBe('https://lh3.googleusercontent.com/a-/ALV-Uj');
    expect(contact.displayName).toBeUndefined();
    expect(normalizeNylasContact(contact, 'inbox')).toMatchObject({
      providerContactId: 'otherContacts/c2285657842241455500',
      source: 'inbox',
      emails: [{ email: 'ops@cardhunt.example.test' }],
    });
  });

  test('domain reads the directory profiles with a numeric id', async () => {
    const g = google();
    g.on(/\/people:listDirectoryPeople$/, { json: { people: [directoryPerson], nextPageToken: 'd2' } });
    const page = await adapter.list({ identifier: GRANT, queryParams: { source: 'domain', limit: 100 } });
    expect(g.calls[0].url.searchParams.get('sources')).toBe('DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE');
    expect(g.calls[0].url.searchParams.get('readMask')).toBe(
      'names,nicknames,emailAddresses,phoneNumbers,photos,organizations',
    );
    expect(page.nextCursor).toBe('d2');
    const [person] = page.data as any[];
    expect(person.id).toBe('112500239746871362125');
    expect(person.emails).toEqual([
      { email: 'mia@work.example.test' },
      { email: 'mia.stone@gmail.example.test', type: 'work' },
    ]);
    expect(normalizeNylasContact(person, 'domain')).toMatchObject({
      providerContactId: '112500239746871362125',
      source: 'domain',
      displayName: 'Mia Stone',
    });
  });

  test('without a source it reads saved contacts', async () => {
    const g = google();
    g.on(/\/people\/me\/connections$/, { json: {} });
    const page = await adapter.list({ grantId: GRANT });
    expect(page.data).toEqual([]);
    expect(g.calls[0].url.searchParams.has('pageSize')).toBe(false);
  });

  test('a missing scope is a 403 that the sync reads as a source state', async () => {
    const g = google();
    g.on(/\/otherContacts$/, {
      status: 403,
      json: {
        error: {
          code: 403,
          message: 'Request had insufficient authentication scopes.',
          status: 'PERMISSION_DENIED',
        },
      },
    });
    const error = (await adapter
      .list({ identifier: GRANT, queryParams: { source: 'inbox' } })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error.statusCode).toBe(403);
  });

  test('rejects a call without a grant id', async () => {
    const error = (await adapter.list({ queryParams: {} }).catch((e: unknown) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(400);
  });
});

describe('contacts.list by email', () => {
  test('searches each source, warms the search cache once, and keeps exact matches', async () => {
    const g = google();
    g.on(/\/people:searchContacts$/, (call) =>
      call.url.searchParams.get('query')
        ? {
            json: {
              results: [
                { person: savedContact },
                {
                  person: {
                    ...savedContact,
                    resourceName: 'people/c1',
                    emailAddresses: [{ value: 'bea2@x.test' }],
                  },
                },
                {},
              ],
            },
          }
        : { json: {} },
    );
    g.on(/\/otherContacts:search$/, (call) =>
      call.url.searchParams.get('query')
        ? {
            json: {
              results: [
                { person: { ...otherContact, emailAddresses: [{ value: 'BEA@plug.example.test' }] } },
              ],
            },
          }
        : { json: {} },
    );
    g.on(/\/people:searchDirectoryPeople$/, {
      status: 400,
      json: { error: { code: 400, message: 'Directory is not available', status: 'FAILED_PRECONDITION' } },
    });

    const page = await adapter.list({
      identifier: GRANT,
      queryParams: { email: ' Bea@Plug.example.test ', limit: 5 },
    });
    expect((page.data as any[]).map((contact) => [contact.id, contact.source])).toEqual([
      ['c6993101230118454048', 'address_book'],
      ['otherContacts/c2285657842241455500', 'inbox'],
    ]);
    const searches = g.calls.map((call) => [
      call.url.pathname.split('/').pop(),
      call.url.searchParams.get('query'),
    ]);
    expect(searches).toEqual([
      ['people:searchContacts', ''],
      ['people:searchContacts', 'bea@plug.example.test'],
      ['otherContacts:search', ''],
      ['otherContacts:search', 'bea@plug.example.test'],
      ['people:searchDirectoryPeople', 'bea@plug.example.test'],
    ]);
    expect(g.calls[3].url.searchParams.get('readMask')).toBe('names,emailAddresses,phoneNumbers');
    expect(g.calls[1].url.searchParams.get('pageSize')).toBe('5');

    // The warm-up runs one time for each grant and search.
    await adapter.list({ identifier: GRANT, queryParams: { email: 'bea@plug.example.test', limit: 1 } });
    const warmups = g.calls.filter((call) => call.url.searchParams.get('query') === '');
    expect(warmups).toHaveLength(2);
  });

  test('one source searches only that source and lets its error through', async () => {
    const g = google();
    g.on(/\/people:searchDirectoryPeople$/, { json: { people: [directoryPerson] } });
    const page = await adapter.list({
      identifier: GRANT,
      queryParams: { email: 'mia@work.example.test', source: 'domain' },
    });
    expect((page.data as any[])[0].id).toBe('112500239746871362125');
    expect(g.calls).toHaveLength(1);

    g.on(/\/otherContacts:search$/, { status: 403, json: { error: { code: 403, message: 'denied' } } });
    const error = (await adapter
      .list({ identifier: GRANT, queryParams: { email: 'mia@work.example.test', source: 'inbox' } })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(403);
  });

  test('throws when every source fails and returns nothing', async () => {
    google();
    const error = (await adapter
      .list({ identifier: GRANT, queryParams: { email: 'nobody@example.test' } })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error.statusCode).toBe(404);
  });
});

describe('contacts.find', () => {
  test('reads a saved contact or a directory person by its stored id', async () => {
    const g = google();
    g.on(/\/people\/c6993101230118454048$/, { json: savedContact });
    g.on(/\/people\/112500239746871362125$/, { json: directoryPerson });
    const saved = await adapter.find({
      identifier: GRANT,
      contactId: 'c6993101230118454048',
      queryParams: { profilePicture: true },
    });
    expect(saved.data).toMatchObject({ id: 'c6993101230118454048', source: 'address_book' });
    expect((saved.data as any).pictureUrl).toBe('https://lh3.googleusercontent.com/cm/AGPWSu_K2');
    expect(g.calls[0].url.searchParams.get('personFields')).toContain('photos');
    const person = await adapter.find({ identifier: GRANT, contactId: '112500239746871362125' });
    expect(person.data).toMatchObject({ id: '112500239746871362125', source: 'domain' });
  });

  test('an other contact has no single read', async () => {
    const g = google();
    const error = (await adapter
      .find({ identifier: GRANT, contactId: 'otherContacts/c2285657842241455500' })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(501);
    expect(g.calls).toHaveLength(0);
  });

  test('a missing contact is a 404 and a missing id is a 400', async () => {
    google();
    const missing = (await adapter
      .find({ identifier: GRANT, contactId: 'c9' })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(missing.statusCode).toBe(404);
    const noId = (await adapter.find({ identifier: GRANT }).catch((e: unknown) => e)) as GoogleApiError;
    expect(noId.statusCode).toBe(400);
  });
});

describe('contact id rules', () => {
  test('match the ids that Nylas stored', () => {
    expect(contactIdFromResourceName('people/c123')).toBe('c123');
    expect(contactIdFromResourceName('people/1045')).toBe('1045');
    expect(contactIdFromResourceName('otherContacts/c9')).toBe('otherContacts/c9');
    expect(contactIdFromResourceName(undefined)).toBeUndefined();
    expect(resourceNameFromContactId('c123')).toBe('people/c123');
    expect(resourceNameFromContactId('people/c123')).toBe('people/c123');
    expect(resourceNameFromContactId('otherContacts/c9')).toBe('otherContacts/c9');
    expect(sourceForContactId('c123')).toBe('address_book');
    expect(sourceForContactId('1045')).toBe('domain');
    expect(sourceForContactId('otherContacts/c9')).toBe('inbox');
  });
});

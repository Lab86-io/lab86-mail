import type { ContactSource } from '@/lib/contacts/model';
import {
  type GooglePerson,
  googlePersonToNylasContact,
  OTHER_CONTACT_PREFIX,
  personHasEmail,
  resourceNameFromContactId,
  sourceForContactId,
} from '../contacts-map';
import { GoogleApiError, googleJson, googleUrl, PEOPLE_API } from '../http';
import type { GoogleNylasAdapter } from './types';

// Google People API: contacts, with the argument and result shapes of the
// Nylas SDK. The three Nylas sources map to three People API lists:
// - `address_book` (saved contacts): people.connections.list;
// - `inbox` (Google "Other contacts"): otherContacts.list;
// - `domain` (the work directory): people.listDirectoryPeople.
// An `email` filter uses the search call of each source and keeps the people
// that have exactly that address.

const PERSON_FIELDS = 'names,nicknames,emailAddresses,phoneNumbers,photos,organizations,memberships';
const OTHER_CONTACT_FIELDS = 'names,emailAddresses,phoneNumbers,photos';
// otherContacts.search does not accept `photos`.
const OTHER_CONTACT_SEARCH_FIELDS = 'names,emailAddresses,phoneNumbers';
const DIRECTORY_FIELDS = 'names,nicknames,emailAddresses,phoneNumbers,photos,organizations';
const DIRECTORY_SOURCE = 'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE';
// Profile data (names and photos from the person's Google profile) comes
// with other contacts, as it did through Nylas.
const OTHER_CONTACT_SOURCES = ['READ_SOURCE_TYPE_CONTACT', 'READ_SOURCE_TYPE_PROFILE'];
const MAX_PAGE = 1_000;
const MAX_SEARCH_PAGE = 30;
const SEARCH_ORDER: ContactSource[] = ['address_book', 'inbox', 'domain'];

function requestId() {
  return globalThis.crypto.randomUUID();
}

function grantOf(args: any): string {
  const grantId = args?.identifier ?? args?.grantId;
  if (typeof grantId !== 'string' || !grantId) throw new GoogleApiError(400, 'A grant id is required.');
  return grantId;
}

function pageSize(limit: unknown, max: number): number | undefined {
  const value = Number(limit);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : undefined;
}

function sourceOf(value: unknown): ContactSource | undefined {
  return value === 'address_book' || value === 'inbox' || value === 'domain' ? value : undefined;
}

interface SourcePage {
  people: GooglePerson[];
  nextPageToken?: string;
}

async function listSource(grantId: string, source: ContactSource, query: any): Promise<SourcePage> {
  const size = pageSize(query.limit, MAX_PAGE);
  if (source === 'inbox') {
    const page = await googleJson<{ otherContacts?: GooglePerson[]; nextPageToken?: string }>(
      grantId,
      googleUrl(`${PEOPLE_API}/otherContacts`, {
        readMask: OTHER_CONTACT_FIELDS,
        sources: OTHER_CONTACT_SOURCES,
        pageSize: size,
        pageToken: query.pageToken,
      }),
    );
    return { people: page?.otherContacts || [], nextPageToken: page?.nextPageToken };
  }
  if (source === 'domain') {
    const page = await googleJson<{ people?: GooglePerson[]; nextPageToken?: string }>(
      grantId,
      googleUrl(`${PEOPLE_API}/people:listDirectoryPeople`, {
        readMask: DIRECTORY_FIELDS,
        sources: DIRECTORY_SOURCE,
        pageSize: size,
        pageToken: query.pageToken,
      }),
    );
    return { people: page?.people || [], nextPageToken: page?.nextPageToken };
  }
  const page = await googleJson<{ connections?: GooglePerson[]; nextPageToken?: string }>(
    grantId,
    googleUrl(`${PEOPLE_API}/people/me/connections`, {
      personFields: PERSON_FIELDS,
      pageSize: size,
      pageToken: query.pageToken,
    }),
  );
  return { people: page?.connections || [], nextPageToken: page?.nextPageToken };
}

// Google asks for one search with an empty query before the first real
// search, so that its search cache is current.
const warmed = new Set<string>();
const WARM_LIMIT = 5_000;

async function warmSearch(grantId: string, url: string, readMask: string) {
  const key = `${grantId}\n${url}`;
  if (warmed.has(key)) return;
  // `googleUrl` skips empty values, and Google wants the empty query sent.
  await googleJson(grantId, `${googleUrl(url, { readMask })}&query=`).catch(() => undefined);
  warmed.add(key);
  if (warmed.size > WARM_LIMIT) warmed.delete(warmed.values().next().value as string);
}

export function __resetContactsAdapterCacheForTest() {
  warmed.clear();
}

async function searchSource(
  grantId: string,
  source: ContactSource,
  email: string,
  limit: number | undefined,
): Promise<GooglePerson[]> {
  if (source === 'domain') {
    const page = await googleJson<{ people?: GooglePerson[] }>(
      grantId,
      googleUrl(`${PEOPLE_API}/people:searchDirectoryPeople`, {
        query: email,
        readMask: DIRECTORY_FIELDS,
        sources: DIRECTORY_SOURCE,
        pageSize: limit,
      }),
    );
    return page?.people || [];
  }
  const url =
    source === 'inbox' ? `${PEOPLE_API}/otherContacts:search` : `${PEOPLE_API}/people:searchContacts`;
  const readMask = source === 'inbox' ? OTHER_CONTACT_SEARCH_FIELDS : PERSON_FIELDS;
  await warmSearch(grantId, url, readMask);
  const page = await googleJson<{ results?: Array<{ person?: GooglePerson }> }>(
    grantId,
    googleUrl(url, { query: email, readMask, pageSize: pageSize(limit, MAX_SEARCH_PAGE) }),
  );
  return (page?.results || [])
    .map((result) => result.person)
    .filter((person): person is GooglePerson => Boolean(person));
}

/** The people with exactly this address, from one source or from all three. */
async function listByEmail(grantId: string, email: string, query: any) {
  const source = sourceOf(query.source);
  const limit = pageSize(query.limit, MAX_SEARCH_PAGE);
  const data: ReturnType<typeof googlePersonToNylasContact>[] = [];
  const errors: unknown[] = [];
  for (const each of source ? [source] : SEARCH_ORDER) {
    try {
      for (const person of await searchSource(grantId, each, email, limit)) {
        if (personHasEmail(person, email)) data.push(googlePersonToNylasContact(person, each, grantId));
      }
    } catch (err) {
      // Without a source, a source that the grant cannot read (a consumer
      // account has no directory) does not stop the other sources.
      if (source) throw err;
      errors.push(err);
    }
  }
  if (!data.length && errors.length === SEARCH_ORDER.length) throw errors[0];
  return { data: limit ? data.slice(0, limit) : data, requestId: requestId() };
}

async function listContacts(args: any) {
  const grantId = grantOf(args);
  const query = args?.queryParams || {};
  const email = typeof query.email === 'string' ? query.email.trim().toLowerCase() : '';
  if (email) return listByEmail(grantId, email, query);
  const source = sourceOf(query.source) ?? 'address_book';
  const page = await listSource(grantId, source, query);
  const result: { data: unknown[]; requestId: string; nextCursor?: string } = {
    data: page.people.map((person) => googlePersonToNylasContact(person, source, grantId)),
    requestId: requestId(),
  };
  if (page.nextPageToken) result.nextCursor = page.nextPageToken;
  return result;
}

async function findContact(args: any) {
  const grantId = grantOf(args);
  const contactId = typeof args?.contactId === 'string' ? args.contactId.trim() : '';
  if (!contactId) throw new GoogleApiError(400, 'A contact id is required.');
  if (contactId.startsWith(OTHER_CONTACT_PREFIX)) {
    // The People API has no call that reads one other contact by its id.
    throw new GoogleApiError(501, 'contacts.find is not available for a Google other contact.');
  }
  const person = await googleJson<GooglePerson>(
    grantId,
    googleUrl(`${PEOPLE_API}/${resourceNameFromContactId(contactId)}`, { personFields: PERSON_FIELDS }),
  );
  return {
    data: googlePersonToNylasContact(person, sourceForContactId(contactId), grantId),
    requestId: requestId(),
  };
}

export const googleContactsAdapter: GoogleNylasAdapter = {
  contacts: {
    list: listContacts,
    find: findContact,
  },
};

// Direct Google transport: People API persons in the Nylas v3 contact shape
// that lib/contacts/model.ts (`normalizeNylasContact`) and the photo lookup
// read.
//
// The ids copy what Nylas v3 stored for Google accounts (checked against
// production rows on 2026-09-28), so stored contact rows stay valid:
// - a saved contact (`people/c123`) is `c123`;
// - a directory person (`people/1045`) is `1045`;
// - an other contact keeps its full name, `otherContacts/c123`.

import type { ContactSource } from '@/lib/contacts/model';
import { compact } from './calendar-map';

interface GoogleFieldMetadata {
  primary?: boolean;
  source?: { type?: string; id?: string };
}

export interface GooglePerson {
  resourceName?: string;
  names?: Array<{
    displayName?: string;
    givenName?: string;
    familyName?: string;
    middleName?: string;
    honorificSuffix?: string;
    metadata?: GoogleFieldMetadata;
  }>;
  nicknames?: Array<{ value?: string; metadata?: GoogleFieldMetadata }>;
  emailAddresses?: Array<{ value?: string; type?: string; metadata?: GoogleFieldMetadata }>;
  phoneNumbers?: Array<{ value?: string; type?: string; metadata?: GoogleFieldMetadata }>;
  photos?: Array<{ url?: string; default?: boolean; metadata?: GoogleFieldMetadata }>;
  organizations?: Array<{ name?: string; title?: string; metadata?: GoogleFieldMetadata }>;
  memberships?: Array<{
    contactGroupMembership?: { contactGroupId?: string; contactGroupResourceName?: string };
  }>;
}

export const OTHER_CONTACT_PREFIX = 'otherContacts/';
const PEOPLE_PREFIX = 'people/';

/** The contact id that Nylas stored for a People API resource name. */
export function contactIdFromResourceName(resourceName: string | undefined): string | undefined {
  if (!resourceName) return undefined;
  return resourceName.startsWith(PEOPLE_PREFIX) ? resourceName.slice(PEOPLE_PREFIX.length) : resourceName;
}

/** The People API resource name of a stored contact id. */
export function resourceNameFromContactId(contactId: string): string {
  if (contactId.startsWith(PEOPLE_PREFIX) || contactId.startsWith(OTHER_CONTACT_PREFIX)) return contactId;
  return `${PEOPLE_PREFIX}${contactId}`;
}

/** A saved contact id starts with `c`; a directory profile id is a number. */
export function sourceForContactId(contactId: string): ContactSource {
  if (contactId.startsWith(OTHER_CONTACT_PREFIX)) return 'inbox';
  return /^(?:people\/)?c/.test(contactId) ? 'address_book' : 'domain';
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** The primary item of a People field, else the first. */
function primary<T extends { metadata?: GoogleFieldMetadata }>(items: T[] | undefined): T | undefined {
  if (!Array.isArray(items) || !items.length) return undefined;
  return items.find((item) => item?.metadata?.primary) ?? items[0];
}

export function googlePersonToNylasContact(person: GooglePerson, source: ContactSource, grantId: string) {
  const name = primary(person.names);
  const organization = primary(person.organizations);
  const photo = primary(person.photos);
  const groups = (person.memberships || [])
    .map((membership) => text(membership?.contactGroupMembership?.contactGroupId))
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id, object: 'contact_group' }));
  return compact({
    id: contactIdFromResourceName(person.resourceName) || '',
    grantId,
    object: 'contact',
    source,
    displayName: text(name?.displayName),
    givenName: text(name?.givenName),
    middleName: text(name?.middleName),
    surname: text(name?.familyName),
    suffix: text(name?.honorificSuffix),
    nickname: text(primary(person.nicknames)?.value),
    emails: (person.emailAddresses || [])
      .filter((item) => text(item?.value))
      .map((item) => compact({ email: item.value as string, type: text(item.type) })),
    phoneNumbers: (person.phoneNumbers || [])
      .filter((item) => text(item?.value))
      .map((item) => compact({ number: item.value as string, type: text(item.type) })),
    pictureUrl: text(photo?.url),
    companyName: text(organization?.name),
    jobTitle: text(organization?.title),
    groups,
    imAddresses: [],
    physicalAddresses: [],
    webPages: [],
  });
}

/** True when one of the person's addresses equals `email` (lowercase). */
export function personHasEmail(person: GooglePerson, email: string): boolean {
  return (person.emailAddresses || []).some((item) => item?.value?.trim().toLowerCase() === email);
}

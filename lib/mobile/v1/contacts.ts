import type { ContactAccountStatus } from '@/lib/contacts/lookup';
import type { RecipientSuggestion } from '@/lib/contacts/recipients';
import { stripLoneSurrogates, truncateText } from '@/lib/shared/text';
import {
  ContactAccountStatusSchema,
  type ContactAccountStatusV1,
  RecipientSuggestionSchema,
  type RecipientSuggestionV1,
} from './contract';

// Mapping boundary between the contact services and the strict v1 schemas.
// Text is cleaned and capped here, so one odd provider string never fails a
// native decode.

function text(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const clean = stripLoneSurrogates(value).trim();
  return clean ? truncateText(clean, max) : undefined;
}

function httpsURL(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.toString().length <= 2_048 ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function recipientSuggestionV1(item: RecipientSuggestion): RecipientSuggestionV1 {
  const name = text(item.name, 200);
  const email = truncateText(item.email, 320);
  const highlights = item.highlights
    .filter((entry) => {
      const target = entry.field === 'name' ? name : email;
      return (
        Boolean(target) &&
        entry.start >= 0 &&
        entry.length > 0 &&
        entry.start + entry.length <= target!.length
      );
    })
    .slice(0, 4);
  return RecipientSuggestionSchema.parse({
    id: email,
    email,
    name,
    alternateEmails: item.alternateEmails.length ? item.alternateEmails.slice(0, 5) : undefined,
    savedContact: item.savedContact,
    directory: item.directory,
    sources: item.sources.slice(0, 5),
    company: text(item.company, 200),
    jobTitle: text(item.jobTitle, 200),
    photoURL: httpsURL(item.photoUrl),
    lastContactedAt: item.lastContactedAt ? Math.floor(item.lastContactedAt) : undefined,
    sentCount: Math.max(0, Math.floor(item.sentCount)),
    receivedCount: Math.max(0, Math.floor(item.receivedCount)),
    highlights,
    score: Number.isFinite(item.score) ? item.score : 0,
  });
}

const SOURCE_NAMES = { address_book: 'addressBook', inbox: 'inbox', domain: 'domain' } as const;
const SOURCE_STATES = {
  ok: 'ok',
  missing_scope: 'missingScope',
  unsupported: 'unsupported',
  capped: 'capped',
  error: 'error',
} as const;

export function contactAccountStatusV1(status: ContactAccountStatus): ContactAccountStatusV1 {
  return ContactAccountStatusSchema.parse({
    accountID: status.accountId,
    email: truncateText(status.email, 320),
    provider: status.provider,
    state: status.state,
    needsReconnect: status.needsReconnect,
    contactCount: status.contactCount,
    lastSyncedAt: status.lastSyncedAt ? Math.floor(status.lastSyncedAt) : undefined,
    sources: status.sources.slice(0, 3).map((entry) => ({
      source: SOURCE_NAMES[entry.source],
      state: SOURCE_STATES[entry.state],
      ...(typeof entry.count === 'number' ? { count: Math.max(0, Math.floor(entry.count)) } : {}),
    })),
    message: text(status.message, 300),
  });
}

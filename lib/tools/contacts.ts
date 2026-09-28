import { z } from 'zod';
import { suggestRecipients } from '../contacts/lookup';
import { expandAliasFromCandidates, type SuggestionSource } from '../contacts/model';
import type { RecipientSuggestion } from '../contacts/recipients';
import { resolveConnectedAccount } from '../nylas/provider';
import { defineTool } from './registry';

// The assistant's contact tools. Both read the recipient search (saved
// contacts, people the user wrote to, the work directory, and the mail
// correspondent index), so the assistant finds the same people as the To
// field. Outputs stay small: names, addresses, and a source.

interface ContactToolDeps {
  suggest: typeof suggestRecipients;
  resolveAccount: typeof resolveConnectedAccount;
}

const defaultDeps: ContactToolDeps = { suggest: suggestRecipients, resolveAccount: resolveConnectedAccount };
let deps = defaultDeps;

export function setContactToolDependenciesForTest(overrides: Partial<ContactToolDeps> = {}) {
  deps = { ...defaultDeps, ...overrides };
  return () => {
    deps = defaultDeps;
  };
}

const ALL_ACCOUNTS = new Set(['', '__all__', 'all']);

/** The mailbox id for the From boost, or undefined for all mailboxes. */
async function fromAccountId(userId: string, account: string | undefined) {
  const ref = String(account || '').trim();
  if (ALL_ACCOUNTS.has(ref.toLowerCase())) return undefined;
  const row = await deps.resolveAccount(userId, ref).catch(() => null);
  return row?.accountId;
}

function sourceOf(item: RecipientSuggestion): SuggestionSource {
  if (item.savedContact) return 'address_book';
  if (item.sources.includes('inbox')) return 'inbox';
  if (item.directory) return 'domain';
  return 'recent';
}

const contactOutput = z.object({
  name: z.string().optional(),
  email: z.string(),
  otherEmails: z.array(z.string()).optional(),
  source: z.enum(['address_book', 'inbox', 'domain', 'recent']),
  company: z.string().optional(),
  jobTitle: z.string().optional(),
  lastContactedAt: z.string().optional(),
});

function compact(item: RecipientSuggestion): z.infer<typeof contactOutput> {
  return {
    ...(item.name ? { name: item.name } : {}),
    email: item.email,
    ...(item.alternateEmails.length ? { otherEmails: item.alternateEmails.slice(0, 3) } : {}),
    source: sourceOf(item),
    ...(item.company ? { company: item.company } : {}),
    ...(item.jobTitle ? { jobTitle: item.jobTitle } : {}),
    ...(item.lastContactedAt ? { lastContactedAt: new Date(item.lastContactedAt).toISOString() } : {}),
  };
}

export const contactLookup = defineTool({
  name: 'contact_lookup',
  description:
    "Find people by name, nickname, initials, company, or email address in the user's contacts and mail history. Results are ranked: saved contacts, then people the user writes to, then the work directory, then recent senders.",
  category: 'contacts',
  mutating: false,
  input: z.object({
    account: z
      .string()
      .default('__all__')
      .describe('A connected mailbox address or id to rank its people first, or "__all__".'),
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(20).default(8),
  }),
  output: z.object({ contacts: z.array(contactOutput) }),
  async handler({ account, query, limit }, ctx) {
    if (!ctx.userId) return { contacts: [] };
    const result = await deps.suggest(ctx.userId, {
      query,
      fromAccountId: await fromAccountId(ctx.userId, account),
      limit,
    });
    // A typed address that no index knows is not a contact.
    return {
      contacts: result.items.filter((item) => !item.sources.includes('typed')).map(compact),
    };
  },
});

export const expandAlias = defineTool({
  name: 'expand_alias',
  description:
    'Resolve a first name, nickname, or full name to one email address. It answers only when one person matches; otherwise email is null and candidates lists the people to ask about.',
  category: 'contacts',
  mutating: false,
  input: z.object({
    account: z.string().default('__all__'),
    alias: z.string().trim().min(1).max(200),
  }),
  output: z.object({
    email: z.string().nullable(),
    displayName: z.string().optional(),
    candidates: z
      .array(
        z.object({
          email: z.string(),
          name: z.string().optional(),
          source: z.enum(['address_book', 'inbox', 'domain', 'recent']),
        }),
      )
      .optional(),
  }),
  async handler({ account, alias }, ctx) {
    if (!ctx.userId) return { email: null };
    const result = await deps.suggest(ctx.userId, {
      query: alias,
      fromAccountId: await fromAccountId(ctx.userId, account),
      limit: 20,
    });
    const people = result.items
      .filter((item) => !item.sources.includes('typed'))
      .map((item) => ({
        source: sourceOf(item),
        name: item.name,
        emails: [item.email, ...item.alternateEmails],
      }));
    const expansion = expandAliasFromCandidates(alias, people);
    return {
      email: expansion.email,
      ...(expansion.displayName ? { displayName: expansion.displayName } : {}),
      ...(expansion.candidates.length ? { candidates: expansion.candidates.slice(0, 5) } : {}),
    };
  },
});

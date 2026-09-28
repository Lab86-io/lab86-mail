import { api, convexQuery } from '@/lib/hosted/convex';
import { isConvexConfigured } from '@/lib/hosted/env';
import { emailFromHeader } from '@/lib/shared/format';
import { isWeakHeaderName, preferredSenderName } from './model';

// Saved names for mail senders. A contact name (saved contact or work
// directory, never an `inbox` guess) replaces only a weak header name: a
// bare address, or a name that only repeats the address.

type Query = typeof convexQuery;

/** Written contact names for the given addresses, lowercased keys. */
export async function contactNamesFor(
  userId: string,
  emails: string[],
  query: Query = convexQuery,
): Promise<Map<string, string>> {
  const unique = [...new Set(emails.map((email) => email.toLowerCase()).filter(Boolean))].slice(0, 300);
  if (!unique.length) return new Map();
  const result = await query<{ names: Array<{ email: string; name: string }> }>(api.contacts.namesForEmails, {
    userId,
    emails: unique,
  });
  return new Map((result?.names || []).map((entry) => [entry.email, entry.name]));
}

/**
 * Adds `field` (for example `senderName`) to each item whose header name is
 * weak and whose address has a written contact name. One Convex query for
 * the whole list, and none when every header already has a real name. A
 * failed lookup returns the items unchanged.
 */
export async function withContactNames<T extends object, K extends string>(
  userId: string | null | undefined,
  items: T[],
  header: (item: T) => string | null | undefined,
  field: K,
  query: Query = convexQuery,
): Promise<Array<T & Partial<Record<K, string>>>> {
  if (!userId || !items.length || (query === convexQuery && !isConvexConfigured())) return items;
  const wanted = items
    .map((item) => header(item))
    .filter((value) => isWeakHeaderName(value))
    .map((value) => emailFromHeader(value))
    .filter((email): email is string => Boolean(email));
  if (!wanted.length) return items;
  try {
    const names = await contactNamesFor(userId, wanted, query);
    if (!names.size) return items;
    return items.map((item) => {
      const value = header(item);
      const email = emailFromHeader(value);
      const name = email ? preferredSenderName(value, names.get(email)) : undefined;
      return name ? { ...item, [field]: name } : item;
    });
  } catch (err: any) {
    console.warn('[contacts] sender names failed', err?.message || err);
    return items;
  }
}

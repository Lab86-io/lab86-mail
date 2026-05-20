import { z } from 'zod';
import { runGogJson } from '../gog/pool';
import { getPhotoFromCache, setPhotoCache } from '../store/photos';
import { defineTool } from './registry';

// Treat any Google "default" photo (the gray monogram letter Google serves
// when there's no real picture) as "no photo" so we keep our nicer
// boring-avatar instead of swapping in a flat gray circle.
function extractPhotoUrl(person: any): string | null {
  const photos: any[] = person?.photos || [];
  for (const p of photos) {
    if (p?.default) continue;
    if (typeof p?.url === 'string' && p.url) return p.url as string;
  }
  return null;
}

async function lookupOwnAccountPhoto(account: string): Promise<string | null> {
  const raw = await runGogJson<any>(['--account', account, '--json', 'people', 'me', '--no-input'], {
    timeoutMs: 15_000,
  }).catch(() => null);
  const person = raw?.person || raw?.result || raw;
  return extractPhotoUrl(person);
}

async function lookupContactPhoto(account: string, email: string): Promise<string | null> {
  // Search the directory for the email; if there's a hit, fetch the full
  // profile for the photo URL. Workspace-only API: non-Workspace accounts
  // (plain @gmail) get a 400 "Must be a G Suite domain user" — caught and
  // cached as null below.
  const search = await runGogJson<any>(
    ['--account', account, '--json', 'people', 'search', email, '--limit', '1', '--no-input'],
    { timeoutMs: 15_000 },
  ).catch(() => null);
  const top = search?.people?.[0] || search?.contacts?.[0] || search?.results?.[0];
  const resourceName: string | null =
    top?.resource || top?.resourceName || (top?.id ? `people/${top.id}` : null);
  if (!resourceName) return null;
  const detail = await runGogJson<any>(
    ['--account', account, '--json', 'people', 'get', resourceName, '--no-input'],
    { timeoutMs: 15_000 },
  ).catch(() => null);
  const person = detail?.person || detail?.result || detail;
  return extractPhotoUrl(person);
}

export const resolvePhotos = defineTool({
  name: 'resolve_photos',
  description:
    "Resolve Google profile photo URLs for a batch of email addresses. Returns the user's own photo for their own authed accounts and the contact photo for senders in Google Contacts. Everyone else maps to null. Results are cached for ~7 days (negative results too).",
  category: 'contacts',
  mutating: false,
  input: z.object({
    account: z.string(),
    emails: z.array(z.string()).max(200),
  }),
  output: z.object({ photos: z.record(z.string(), z.string().nullable()) }),
  async handler({ account, emails }) {
    const out: Record<string, string | null> = {};
    const seen = new Set<string>();

    // Authed account list — used to route own-mailbox lookups through
    // people/me which works even on non-Workspace accounts.
    let authedEmails: string[] = [];
    try {
      const accountsRaw = await runGogJson<any>(['auth', 'list', '--json', '--no-input'], {
        timeoutMs: 15_000,
      });
      const arr = accountsRaw?.accounts || [];
      authedEmails = (Array.isArray(arr) ? arr : [])
        .map((a: any) => (typeof a === 'string' ? a : a?.email))
        .filter((s: any): s is string => typeof s === 'string')
        .map((s: string) => s.toLowerCase());
    } catch {
      authedEmails = [account.toLowerCase()];
    }
    const authedSet = new Set(authedEmails);

    for (const raw of emails) {
      const email = (raw || '').trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);

      const cached = await getPhotoFromCache(email).catch(() => null);
      if (cached) {
        out[email] = cached.url;
        continue;
      }

      let url: string | null = null;
      try {
        if (authedSet.has(email)) {
          url = await lookupOwnAccountPhoto(email);
        } else {
          url = await lookupContactPhoto(account, email);
        }
      } catch {
        url = null;
      }
      await setPhotoCache(email, url).catch(() => undefined);
      out[email] = url;
    }

    return { photos: out };
  },
});

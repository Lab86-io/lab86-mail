import { z } from 'zod';
import { isNylasConfigured } from '../hosted/env';
import { requireNylas } from '../nylas/client';
import { resolveConnectedAccount } from '../nylas/provider';
import { getPhotoFromCache, setPhotoCache } from '../store/photos';
import { defineTool } from './registry';

const PERSONAL_DOMAINS = new Set([
  'aol.com',
  'fastmail.com',
  'gmail.com',
  'googlemail.com',
  'hey.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'mac.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'pm.me',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
  'ymail.com',
]);

const RESERVED_DOMAINS = new Set(['example.com', 'example.net', 'example.org']);

export const resolvePhotos = defineTool({
  name: 'resolve_photos',
  description: 'Resolve cached profile photo URLs for a batch of email addresses.',
  category: 'contacts',
  mutating: false,
  input: z.object({
    account: z.string(),
    emails: z.array(z.string()).max(200),
  }),
  output: z.object({ photos: z.record(z.string(), z.string().nullable()) }),
  async handler({ account, emails }, ctx) {
    const out: Record<string, string | null> = {};
    const seen = new Set<string>();

    for (const raw of emails) {
      const email = (raw || '').trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);

      const logoUrl = companyLogoUrl(email);
      const cached = await getPhotoFromCache(email).catch(() => null);
      out[email] = cached?.url || null;
      if (!cached?.url && (!cached || logoUrl)) {
        const url =
          (await resolveProviderProfilePhoto({
            userId: ctx.userId,
            account,
            email,
          }).catch(() => null)) || logoUrl;
        out[email] = url;
        await setPhotoCache(email, url).catch(() => undefined);
      }
    }

    return { photos: out };
  },
});

async function resolveProviderProfilePhoto({
  userId,
  account,
  email,
}: {
  userId?: string | null;
  account: string;
  email: string;
}): Promise<string | null> {
  if (!userId || !account || account === '__all__' || !isNylasConfigured()) return null;
  const row = await resolveConnectedAccount(userId, account);
  if (!row || row.status !== 'connected') return null;

  const page = await requireNylas().contacts.list({
    identifier: row.grantId,
    queryParams: { email, limit: 5 },
  });
  const contact = (page.data || []).find((candidate: any) =>
    (candidate.emails || []).some((item: any) => String(item.email || '').toLowerCase() === email),
  );
  const direct = photoUrlFromContact(contact);
  if (direct) return direct;
  if (!contact?.id) return null;

  const detailed = await requireNylas().contacts.find({
    identifier: row.grantId,
    contactId: contact.id,
    queryParams: { profilePicture: true },
  });
  return photoUrlFromContact(detailed.data);
}

function photoUrlFromContact(contact: any): string | null {
  const value = contact?.pictureUrl || contact?.picture || '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('data:image/')) {
    return trimmed;
  }
  return null;
}

function companyLogoUrl(email: string): string | null {
  const domain = email.split('@')[1]?.toLowerCase() || '';
  if (!isCompanyDomain(domain)) return null;
  return `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(domain)}`;
}

function isCompanyDomain(domain: string): boolean {
  if (!domain || PERSONAL_DOMAINS.has(domain) || RESERVED_DOMAINS.has(domain)) return false;
  if (domain.endsWith('.test') || domain.endsWith('.invalid') || domain.endsWith('.localhost')) return false;
  if (domain === 'localhost' || domain.endsWith('.local')) return false;
  return domain.includes('.');
}

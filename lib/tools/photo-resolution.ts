import { isNylasConfigured } from '../hosted/env';
import { requireNylas } from '../nylas/client';
import { resolveConnectedAccount } from '../nylas/provider';

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

export async function resolvePhotoUrl({
  userId,
  account,
  email,
}: {
  userId?: string | null;
  account: string;
  email: string;
}): Promise<string | null> {
  const providerPhoto = await resolveProviderProfilePhoto({ userId, account, email }).catch(() => null);
  return providerPhoto || companyLogoUrl(email);
}

export async function resolveProviderProfilePhoto({
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

export function photoUrlFromContact(contact: any): string | null {
  const value = contact?.pictureUrl || contact?.picture || '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('data:image/')) {
    return trimmed;
  }
  return null;
}

export function companyLogoUrl(email: string): string | null {
  const domain = email.split('@')[1]?.toLowerCase() || '';
  if (!isCompanyDomain(domain)) return null;
  return `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(domain)}`;
}

export function isCompanyDomain(domain: string): boolean {
  if (!domain || PERSONAL_DOMAINS.has(domain) || RESERVED_DOMAINS.has(domain)) return false;
  if (domain.endsWith('.test') || domain.endsWith('.invalid') || domain.endsWith('.localhost')) return false;
  if (domain === 'localhost' || domain.endsWith('.local')) return false;
  return domain.includes('.');
}

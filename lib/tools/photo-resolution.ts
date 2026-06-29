import { isNylasConfigured } from '../hosted/env';
import { requireNylas } from '../nylas/client';
import { listNylasAccounts, type NylasAccountRow, resolveConnectedAccount } from '../nylas/provider';

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
  if (!userId || !account || !isNylasConfigured()) return null;
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return null;
  const rows = await photoCandidateAccounts(userId, account, normalizedEmail);
  for (const row of rows) {
    try {
      const url = await resolveProviderPhotoFromAccount(row, normalizedEmail);
      if (url) return url;
    } catch {
      // Contact photos are opportunistic; try the next connected provider.
    }
  }
  return null;
}

async function photoCandidateAccounts(
  userId: string,
  account: string,
  email: string,
): Promise<NylasAccountRow[]> {
  if (account !== '__all__') {
    const row = await resolveConnectedAccount(userId, account);
    return row?.status === 'connected' ? [row] : [];
  }

  const accounts = await listNylasAccounts(userId).catch(() => []);
  const rows = (
    await Promise.all(
      accounts
        .filter((item) => item.authed)
        .map((item) => resolveConnectedAccount(userId, item.accountId).catch(() => null)),
    )
  ).filter((row): row is NylasAccountRow => Boolean(row && row.status === 'connected'));

  return rows.sort((a, b) => providerPhotoPreference(a, email) - providerPhotoPreference(b, email));
}

async function resolveProviderPhotoFromAccount(row: NylasAccountRow, email: string): Promise<string | null> {
  const page = await requireNylas().contacts.list({
    identifier: row.grantId,
    queryParams: { email, limit: 5 },
  });
  const contact = (page.data || []).find((candidate: any) =>
    (candidate.emails || []).some(
      (item: any) =>
        String(item.email || '')
          .trim()
          .toLowerCase() === email,
    ),
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

function providerPhotoPreference(row: Pick<NylasAccountRow, 'provider'>, email: string) {
  const domain = email.split('@')[1] || '';
  if ((domain === 'gmail.com' || domain === 'googlemail.com') && row.provider === 'google') return 0;
  if (
    ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain) &&
    row.provider === 'microsoft'
  ) {
    return 0;
  }
  if (['icloud.com', 'me.com', 'mac.com'].includes(domain) && row.provider === 'icloud') return 0;
  if (row.provider === 'google') return 1;
  if (row.provider === 'microsoft') return 2;
  if (row.provider === 'icloud') return 3;
  return 4;
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

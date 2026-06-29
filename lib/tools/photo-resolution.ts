import { isNylasConfigured } from '../hosted/env';
import { requireNylas } from '../nylas/client';
import { listNylasAccounts, type NylasAccountRow, resolveConnectedAccount } from '../nylas/provider';

interface PhotoAccountCandidate {
  accountId: string;
  authed?: boolean;
}

interface PhotoResolutionDeps {
  isNylasConfigured: () => boolean;
  requireNylas: typeof requireNylas;
  listNylasAccounts: (userId?: string | null) => Promise<PhotoAccountCandidate[]>;
  resolveConnectedAccount: typeof resolveConnectedAccount;
}

const defaultDeps: PhotoResolutionDeps = {
  isNylasConfigured,
  requireNylas,
  listNylasAccounts,
  resolveConnectedAccount,
};

let deps = defaultDeps;

export function setPhotoResolutionDependenciesForTest(overrides: Partial<PhotoResolutionDeps>) {
  deps = { ...defaultDeps, ...overrides };
  return () => {
    deps = defaultDeps;
  };
}

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
const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'com.au',
  'com.br',
  'com.mx',
  'co.jp',
  'co.nz',
  'com.sg',
  'com.tr',
]);
const LOGO_DOMAIN_ALIASES: Record<string, string> = {
  'microsoftonline.com': 'microsoft.com',
  'office.com': 'microsoft.com',
  'office365.com': 'microsoft.com',
  'onmicrosoft.com': 'microsoft.com',
  'windows.net': 'microsoft.com',
  'appleid.apple.com': 'apple.com',
  'googleusercontent.com': 'google.com',
  'googlemail.com': 'google.com',
  'amazonses.com': 'amazon.com',
};

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
  if (!userId || !account || !deps.isNylasConfigured()) return null;
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
    const row = await deps.resolveConnectedAccount(userId, account);
    return row?.status === 'connected' ? [row] : [];
  }

  const accounts = await deps.listNylasAccounts(userId).catch(() => []);
  const rows = (
    await Promise.all(
      accounts
        .filter((item) => item.authed)
        .map((item) => deps.resolveConnectedAccount(userId, item.accountId).catch(() => null)),
    )
  ).filter((row): row is NylasAccountRow => Boolean(row && row.status === 'connected'));

  return rows.sort((a, b) => providerPhotoPreference(a, email) - providerPhotoPreference(b, email));
}

async function resolveProviderPhotoFromAccount(row: NylasAccountRow, email: string): Promise<string | null> {
  const page = await deps.requireNylas().contacts.list({
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

  const detailed = await deps.requireNylas().contacts.find({
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
  const domain = logoDomainForEmail(email);
  if (!isCompanyDomain(domain)) return null;
  return `/api/logos/${encodeURIComponent(domain)}`;
}

export function companyLogoCandidates(email: string): string[] {
  return companyLogoCandidatesForDomain(logoDomainForEmail(email));
}

export function companyLogoCandidatesForDomain(domain: string): string[] {
  if (!isCompanyDomain(domain)) return [];
  const encoded = encodeURIComponent(domain);
  const out: string[] = [];
  const logoDevToken = process.env.LOGO_DEV_TOKEN || process.env.NEXT_PUBLIC_LOGO_DEV_TOKEN;
  if (logoDevToken) {
    out.push(
      `https://img.logo.dev/${encoded}?token=${encodeURIComponent(logoDevToken)}&size=128&retina=true&format=png`,
    );
  }
  const brandfetchClientId = process.env.BRANDFETCH_CLIENT_ID || process.env.NEXT_PUBLIC_BRANDFETCH_CLIENT_ID;
  if (brandfetchClientId) {
    out.push(`https://cdn.brandfetch.io/${encoded}/w/128/h/128?c=${encodeURIComponent(brandfetchClientId)}`);
  }
  out.push(
    `https://logo.clearbit.com/${encoded}?size=128`,
    `https://icons.duckduckgo.com/ip3/${encoded}.ico`,
    `https://www.google.com/s2/favicons?sz=128&domain=${encoded}`,
  );
  return [...new Set(out)];
}

export function logoDomainForEmail(email: string): string {
  const rawDomain = (email.split('@')[1] || email).trim().toLowerCase().replace(/\.$/, '');
  if (!rawDomain) return '';
  if (LOGO_DOMAIN_ALIASES[rawDomain]) return LOGO_DOMAIN_ALIASES[rawDomain];
  const aliasMatch = Object.entries(LOGO_DOMAIN_ALIASES).find(([suffix]) => rawDomain.endsWith(`.${suffix}`));
  if (aliasMatch) return aliasMatch[1];
  const parts = rawDomain.split('.').filter(Boolean);
  if (parts.length <= 2) return rawDomain;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
  return lastTwo;
}

export function isCompanyDomain(domain: string | null): boolean {
  domain = String(domain || '').toLowerCase();
  if (!domain || PERSONAL_DOMAINS.has(domain) || RESERVED_DOMAINS.has(domain)) return false;
  if (domain.endsWith('.test') || domain.endsWith('.invalid') || domain.endsWith('.localhost')) return false;
  if (domain === 'localhost' || domain.endsWith('.local')) return false;
  return domain.includes('.');
}

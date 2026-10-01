// Direct Google transport: the Gmail "Send mail as" addresses of a mailbox
// (users.settings.sendAs.list). The gmail.modify scope that the app already
// has can read this list.
//
// The list is kept in memory for SEND_AS_CACHE_MS for each grant. A
// reconnect and a removed grant clear it (forgetGmailSendAs). Gmail's own
// signatures are not used: only their presence is reported.

import type { SendAsIdentity, SendAsVerification } from '@/lib/shared/send-as';
import { normalizeAddress } from '@/lib/shared/send-as';
import { GMAIL_API, googleJson } from './http';

export interface GmailSendAs {
  sendAsEmail?: string;
  displayName?: string;
  replyToAddress?: string;
  signature?: string;
  isPrimary?: boolean;
  isDefault?: boolean;
  treatAsAlias?: boolean;
  verificationStatus?: string;
}

export const SEND_AS_CACHE_MS = 10 * 60_000;
const SEND_AS_CACHE_MAX = 1000;

const defaults = {
  fetchSendAs: async (grantId: string) =>
    await googleJson<{ sendAs?: GmailSendAs[] }>(grantId, `${GMAIL_API}/settings/sendAs`),
  now: () => Date.now(),
};
let deps = defaults;
const cache = new Map<string, { at: number; identities: SendAsIdentity[] }>();
const inflight = new Map<string, Promise<SendAsIdentity[]>>();

export function __setGoogleSendAsDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
  cache.clear();
  inflight.clear();
}

function verification(entry: GmailSendAs): SendAsVerification {
  if (entry.isPrimary || entry.verificationStatus === 'accepted') return 'accepted';
  if (entry.verificationStatus === 'pending') return 'pending';
  return 'unknown';
}

/** One Gmail sendAs entry as an identity, or null without an address. */
export function gmailSendAsToIdentity(entry: GmailSendAs): SendAsIdentity | null {
  const email = String(entry?.sendAsEmail || '').trim();
  if (!email) return null;
  const status = verification(entry);
  const displayName = String(entry.displayName || '').trim();
  const replyTo = String(entry.replyToAddress || '').trim();
  return {
    email,
    ...(displayName ? { displayName } : {}),
    isPrimary: Boolean(entry.isPrimary),
    isDefault: Boolean(entry.isDefault),
    verificationStatus: status,
    ...(replyTo ? { replyTo } : {}),
    hasProviderSignature: Boolean(String(entry.signature || '').trim()),
    usable: status === 'accepted',
  };
}

/**
 * The identities of a Gmail sendAs list: the primary address first, then the
 * others in Gmail's order, with one entry for each address. Without a primary
 * entry, `primaryEmail` is added as the primary, so the mailbox address can
 * always send.
 */
export function gmailSendAsIdentities(entries: GmailSendAs[] | undefined, primaryEmail?: string) {
  const seen = new Set<string>();
  const identities: SendAsIdentity[] = [];
  for (const entry of entries || []) {
    const identity = gmailSendAsToIdentity(entry);
    if (!identity) continue;
    const key = normalizeAddress(identity.email);
    if (seen.has(key)) continue;
    seen.add(key);
    identities.push(identity);
  }
  if (primaryEmail && !identities.some((identity) => identity.isPrimary)) {
    const existing = identities.find(
      (identity) => normalizeAddress(identity.email) === normalizeAddress(primaryEmail),
    );
    if (existing) Object.assign(existing, { isPrimary: true, verificationStatus: 'accepted', usable: true });
    else
      identities.unshift({
        email: primaryEmail,
        isPrimary: true,
        isDefault: !identities.some((identity) => identity.isDefault),
        verificationStatus: 'accepted',
        hasProviderSignature: false,
        usable: true,
      });
  }
  return identities.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}

function remember(grantId: string, identities: SendAsIdentity[]) {
  if (!cache.has(grantId) && cache.size >= SEND_AS_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(grantId, { at: deps.now(), identities });
}

/** The send-as identities of a direct Google grant, cached for SEND_AS_CACHE_MS. */
export async function listGmailSendAs(grantId: string, primaryEmail?: string): Promise<SendAsIdentity[]> {
  const cached = cache.get(grantId);
  if (cached && deps.now() - cached.at < SEND_AS_CACHE_MS) return cached.identities;
  let pending = inflight.get(grantId);
  if (!pending) {
    pending = deps
      .fetchSendAs(grantId)
      .then((result) => {
        const identities = gmailSendAsIdentities(result?.sendAs, primaryEmail);
        remember(grantId, identities);
        return identities;
      })
      .finally(() => inflight.delete(grantId));
    inflight.set(grantId, pending);
  }
  return await pending;
}

/** Clears the cached list of a grant (a reconnect or a removed grant). */
export function forgetGmailSendAs(grantId: string): void {
  cache.delete(grantId);
}

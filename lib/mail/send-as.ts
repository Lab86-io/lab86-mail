// Send-as addresses of a connected mailbox, for the composer (web and native)
// and for the compose route.
//
// - A direct Google mailbox lists its Gmail "Send mail as" addresses
//   (lib/google/send-as.ts, cached for 10 minutes).
// - A Nylas mailbox (Microsoft, iCloud, IMAP, or Google through Nylas) lists
//   only its own address. It has no send-as support.
// - The default From of a reply or a forward is the user's address that the
//   original was sent to (To, Cc, or Delivered-To), else Gmail's default
//   send-as address. A new message gets the default send-as address.
//
// Signatures stay Albatross signatures (lib/mail/signature.ts); Gmail's
// signatures are only reported as present.

import { describeModelError } from '@/lib/ai/log-error';
import { listGmailSendAs } from '@/lib/google/send-as';
import { isGoogleDirectGrant } from '@/lib/google/transport';
import { getNylasAccount, getNylasMessageHeaders, type NylasAccountRow } from '@/lib/nylas/provider';
import { resolveSendAnchor } from '@/lib/send/anchor';
import {
  anchorSendAs,
  defaultSendAs,
  isBareAddress,
  normalizeAddress,
  requireUsableSendAs,
  SendAsError,
  type SendAsIdentity,
  type SendAsPage,
  usableSendAs,
} from '@/lib/shared/send-as';
import type { Message } from '@/lib/shared/types';

export type SendAsAccount = Pick<NylasAccountRow, 'accountId' | 'email' | 'grantId' | 'displayName'>;

/** The send-as list could not load, so a chosen address cannot be checked. Nothing was sent. */
export class SendAsUnavailableError extends Error {
  readonly statusCode = 503;

  constructor(message = 'Albatross could not get the From addresses of this mailbox. Try again.') {
    super(message);
    this.name = 'SendAsUnavailableError';
  }
}

const defaults = {
  getAccount: getNylasAccount,
  listGmailSendAs,
  resolveAnchor: resolveSendAnchor,
  getHeaders: getNylasMessageHeaders,
};
let deps = defaults;

export function __setSendAsDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
}

/** The mailbox address as the only identity. */
export function mailboxIdentity(account: Pick<SendAsAccount, 'email' | 'displayName'>): SendAsIdentity {
  const displayName = account.displayName?.trim();
  return {
    email: account.email,
    ...(displayName ? { displayName } : {}),
    isPrimary: true,
    isDefault: true,
    verificationStatus: 'accepted',
    hasProviderSignature: false,
    usable: true,
  };
}

export interface SendAsList {
  identities: SendAsIdentity[];
  aliasesSupported: boolean;
  partial: boolean;
}

/**
 * The send-as identities of one mailbox. When the Gmail list does not load,
 * the list holds only the mailbox address and `partial` is true.
 */
export async function loadSendAsIdentities(account: SendAsAccount): Promise<SendAsList> {
  if (!isGoogleDirectGrant(account.grantId)) {
    return { identities: [mailboxIdentity(account)], aliasesSupported: false, partial: false };
  }
  try {
    const listed = await deps.listGmailSendAs(account.grantId, account.email);
    if (!listed.length) {
      return { identities: [mailboxIdentity(account)], aliasesSupported: true, partial: false };
    }
    // The primary entry has no name when the user never set one in Gmail;
    // the name of the Google account then shows.
    const identities = listed.map((identity) =>
      identity.isPrimary && !identity.displayName && account.displayName
        ? { ...identity, displayName: account.displayName }
        : identity,
    );
    return { identities, aliasesSupported: true, partial: false };
  } catch (error) {
    console.warn('[send-as] the Gmail send-as list did not load', describeModelError(error).message);
    return { identities: [mailboxIdentity(account)], aliasesSupported: true, partial: true };
  }
}

/**
 * The default From of a send. With an anchor (a reply or a forward), the
 * user's address that the original was sent to; else the default send-as
 * address. Delivered-To is read from the provider only when the stored
 * message does not have it and no other header matched.
 */
export async function defaultSendAsFor(
  userId: string,
  account: SendAsAccount,
  identities: SendAsIdentity[],
  anchor?: Pick<Message, '_id' | 'from' | 'to' | 'cc' | 'headers'> | null,
): Promise<SendAsIdentity | undefined> {
  if (anchor && usableSendAs(identities).length > 1) {
    const stored = anchor.headers?.['delivered-to'];
    const match = anchorSendAs(identities, { ...anchor, deliveredTo: stored });
    if (match) return match;
    if (!stored && anchor._id && isGoogleDirectGrant(account.grantId)) {
      const headers = await deps
        .getHeaders({ userId, account: account.accountId, messageId: anchor._id })
        .catch(() => null);
      const delivered = anchorSendAs(identities, { deliveredTo: headers?.['delivered-to'] });
      if (delivered) return delivered;
    }
  }
  return defaultSendAs(identities);
}

/** The send-as page of one mailbox, with the default for a reply or a forward when an anchor is named. */
export async function loadSendAsPage(input: {
  userId: string;
  account: SendAsAccount;
  messageId?: string;
  threadId?: string;
}): Promise<SendAsPage> {
  const { userId, account } = input;
  const list = await loadSendAsIdentities(account);
  const anchor =
    input.messageId || input.threadId
      ? await deps
          .resolveAnchor({
            account: account.accountId,
            messageId: input.messageId,
            threadId: input.threadId,
            userId,
          })
          .catch(() => null)
      : null;
  const chosen = list.partial ? undefined : await defaultSendAsFor(userId, account, list.identities, anchor);
  return {
    accountId: account.accountId,
    aliasesSupported: list.aliasesSupported,
    partial: list.partial,
    identities: list.identities,
    defaultAddress: chosen?.email || account.email,
  };
}

export interface ComposeFrom {
  /** The address to send from; undefined leaves the From to the provider (the mailbox address). */
  fromAddress?: string;
  /** The user's own addresses, which a reply-all leaves out. */
  selfAddresses: string[];
}

/**
 * The From of a compose request. A named address must be a usable send-as
 * address of the mailbox (SendAsError otherwise). Without one, the default
 * applies (defaultSendAsFor). A mailbox without send-as support sends from
 * its own address, as before.
 */
export async function resolveComposeFrom(input: {
  userId: string;
  account: string;
  fromAddress?: string;
  anchor?: Pick<Message, '_id' | 'from' | 'to' | 'cc' | 'headers'> | null;
}): Promise<ComposeFrom> {
  const requested = input.fromAddress?.trim() || undefined;
  if (requested && !isBareAddress(requested)) throw new SendAsError('from_unknown');
  let account: SendAsAccount | null;
  try {
    account = await deps.getAccount(input.userId, input.account);
  } catch (error) {
    if (requested) throw new SendAsUnavailableError();
    console.warn('[send-as] the mailbox did not load', describeModelError(error).message);
    return { selfAddresses: [] };
  }
  // Without a connected mailbox the send fails later with its own message.
  if (!account) return { ...(requested ? { fromAddress: requested } : {}), selfAddresses: [] };
  if (!isGoogleDirectGrant(account.grantId)) {
    if (requested && normalizeAddress(requested) !== normalizeAddress(account.email)) {
      throw new SendAsError('from_unsupported');
    }
    return { selfAddresses: [account.email] };
  }
  const list = await loadSendAsIdentities(account);
  const selfAddresses = list.identities.map((identity) => identity.email);
  if (requested) {
    if (!list.partial)
      return { fromAddress: requireUsableSendAs(list.identities, requested).email, selfAddresses };
    if (normalizeAddress(requested) === normalizeAddress(account.email)) {
      return { fromAddress: account.email, selfAddresses };
    }
    throw new SendAsUnavailableError();
  }
  if (list.partial) return { selfAddresses };
  const chosen = await defaultSendAsFor(input.userId, account, list.identities, input.anchor);
  return { ...(chosen ? { fromAddress: chosen.email } : {}), selfAddresses };
}

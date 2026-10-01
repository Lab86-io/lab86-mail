// Send-as addresses: the addresses one mailbox can send mail from.
//
// A direct Google mailbox has its Gmail "Send mail as" list
// (users.settings.sendAs). Other mailboxes have only their own address.
// This module holds the shared shape and the pure rules; it has no server
// imports, so the web composer can use it too.

export type SendAsVerification = 'accepted' | 'pending' | 'unknown';

export interface SendAsIdentity {
  email: string;
  displayName?: string;
  isPrimary: boolean;
  isDefault: boolean;
  verificationStatus: SendAsVerification;
  replyTo?: string;
  /** Gmail has a signature for this address. Albatross uses its own signatures. */
  hasProviderSignature: boolean;
  /** Only the primary address and addresses that Gmail verified can send. */
  usable: boolean;
}

export interface SendAsPage {
  accountId: string;
  /** False for a mailbox that can send only from its own address. */
  aliasesSupported: boolean;
  /** True when the provider list did not load: `identities` holds only the mailbox address. */
  partial: boolean;
  identities: SendAsIdentity[];
  defaultAddress: string;
}

export type SendAsErrorCode = 'from_unknown' | 'from_unverified' | 'from_unsupported';

const SEND_AS_MESSAGES: Record<SendAsErrorCode, string> = {
  from_unknown: 'The From address is not an address of this mailbox.',
  from_unverified:
    'Gmail did not accept this From address. Complete the steps for this address in Gmail settings, or select a different address.',
  from_unsupported: 'This mailbox can send only from its own address.',
};

/** A From address that the mailbox cannot send from. The send stops before the provider gets it. */
export class SendAsError extends Error {
  readonly statusCode = 400;
  readonly code: SendAsErrorCode;
  readonly reason: SendAsErrorCode;

  constructor(code: SendAsErrorCode, message: string = SEND_AS_MESSAGES[code]) {
    super(message);
    this.name = 'SendAsError';
    this.code = code;
    this.reason = code;
  }
}

export function isSendAsError(error: unknown): error is SendAsError {
  return error instanceof SendAsError || (error as { name?: unknown })?.name === 'SendAsError';
}

export function normalizeAddress(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

/** A bare address: no spaces, no angle brackets, one @ with text on each side. */
export function isBareAddress(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s@<>,;"]+@[^\s@<>,;"]+$/.test(value.trim());
}

/** The identity of `email` (any case), or undefined. */
export function findSendAs(identities: SendAsIdentity[], email: unknown): SendAsIdentity | undefined {
  const needle = normalizeAddress(email);
  if (!needle) return undefined;
  return identities.find((identity) => normalizeAddress(identity.email) === needle);
}

export function usableSendAs(identities: SendAsIdentity[]): SendAsIdentity[] {
  return identities.filter((identity) => identity.usable);
}

/** Gmail's default send-as address when it can send, else the primary address. */
export function defaultSendAs(identities: SendAsIdentity[]): SendAsIdentity | undefined {
  const usable = usableSendAs(identities);
  return (
    usable.find((identity) => identity.isDefault) ||
    usable.find((identity) => identity.isPrimary) ||
    usable[0]
  );
}

/**
 * The identity that `requested` names, when the mailbox can send from it.
 * An address that is not in the list, or that Gmail did not accept, is a
 * SendAsError.
 */
export function requireUsableSendAs(identities: SendAsIdentity[], requested: unknown): SendAsIdentity {
  const identity = findSendAs(identities, requested);
  if (!identity) throw new SendAsError('from_unknown');
  if (!identity.usable) throw new SendAsError('from_unverified');
  return identity;
}

const ADDRESS_PATTERN = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Every address in a header value, lowercased, in order. */
export function addressesInHeader(value: unknown): string[] {
  return (String(value ?? '').match(ADDRESS_PATTERN) || []).map((address) => address.toLowerCase());
}

export interface SendAsAnchor {
  from?: string | null;
  to?: string | null;
  cc?: string | null;
  deliveredTo?: string | null;
}

/**
 * The From address of a reply or a forward: the user's own address that the
 * original came from (a follow-up on a sent message), else the first of the
 * user's addresses in its To, Cc, or Delivered-To header. Undefined when no
 * usable address matches.
 */
export function anchorSendAs(identities: SendAsIdentity[], anchor: SendAsAnchor): SendAsIdentity | undefined {
  const usable = usableSendAs(identities);
  for (const header of [anchor.from, anchor.to, anchor.cc, anchor.deliveredTo]) {
    for (const address of addressesInHeader(header)) {
      const identity = findSendAs(usable, address);
      if (identity) return identity;
    }
  }
  return undefined;
}

/** One row of the composer's From control: an address of one mailbox. */
export interface FromChoice {
  key: string;
  accountId: string;
  email: string;
  name?: string;
  primary: boolean;
}

export function fromChoiceKey(accountId: string, email: string): string {
  return JSON.stringify([accountId, normalizeAddress(email)]);
}

/**
 * The From rows of the composer: the usable send-as addresses of each
 * mailbox, in mailbox order. A mailbox whose list did not load shows its own
 * address only.
 */
export function composerFromChoices(
  accounts: Array<{ accountId: string; email?: string; displayName?: string }>,
  pages: Record<string, Pick<SendAsPage, 'identities'> | undefined>,
): FromChoice[] {
  return accounts.flatMap((account) => {
    const usable = usableSendAs(pages[account.accountId]?.identities || []);
    if (usable.length) {
      return usable.map((identity) => ({
        key: fromChoiceKey(account.accountId, identity.email),
        accountId: account.accountId,
        email: identity.email,
        ...(identity.displayName ? { name: identity.displayName } : {}),
        primary: identity.isPrimary,
      }));
    }
    const email = account.email || account.accountId;
    return [
      {
        key: fromChoiceKey(account.accountId, email),
        accountId: account.accountId,
        email,
        ...(account.displayName ? { name: account.displayName } : {}),
        primary: true,
      },
    ];
  });
}

/** The row of `address` on mailbox `accountId`, else that mailbox's own address. */
export function selectedFromChoice(
  choices: FromChoice[],
  accountId: string,
  address?: string | null,
): FromChoice | undefined {
  const own = choices.filter((choice) => choice.accountId === accountId);
  const wanted = normalizeAddress(address);
  return (
    (wanted ? own.find((choice) => normalizeAddress(choice.email) === wanted) : undefined) ||
    own.find((choice) => choice.primary) ||
    own[0]
  );
}

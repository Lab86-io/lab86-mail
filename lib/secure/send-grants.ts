// Send grants (docs/albatross-goal-runs.md G5, lead decision 2026-10-15): may
// a mail carry a saved value, in a filled PDF, to a recipient domain?
//
// This is a separate permission from an item's sites. A site lets a run type
// the value on pages of that site; a mail domain lets a mail carry it to
// addresses of that domain. Neither one gives the other.
//
// - "Allow for this send" (once): a grant for each (item, domain) of one send
//   (the outbox key), used one time, 30 minutes at most. The client gets a
//   random token; Convex keeps its SHA-256 only. The client sends the mail
//   again with the same pendingId and the token.
// - "Always for mail to <domain>" (always): the domain goes to the item's
//   mailDomains. Settings shows it as "Mail to <domain>".
//
// Both need a recent identity check (the route checks it). No value is read
// here.

import { createHash, randomBytes } from 'node:crypto';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import type { SecureSendAllowRequest, SecureSendAllowResponse } from './contract';
import { SecurePolicyError } from './policy';
import { listSecureItems, normalizeMailDomains, recordSecureUse, SecureStoreError } from './store';

/** "Allow for this send" lasts this long. Convex caps it at 30 minutes. */
export const SEND_GRANT_TTL_MS = 30 * 60_000;
/** The send key of a mail: the outbox key that POST /api/compose takes as pendingId. */
export const SEND_KEY = /^outbox:[a-f0-9-]{36}$/;
/** Only these kinds go into a PDF, so only these can go by mail. */
const MAIL_KINDS = new Set(['id_number', 'date_of_birth']);

export const sendGrantDeps = {
  query: convexQuery as <T>(fn: any, args: Record<string, unknown>) => Promise<T>,
  mutation: convexMutation as <T>(fn: any, args: Record<string, unknown>) => Promise<T>,
  listItems: listSecureItems,
  recordUse: recordSecureUse,
  newToken: () => randomBytes(32).toString('base64url'),
};

export function sendTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Gives the answer of the user. The caller checked the identity first. */
export async function allowSecureSend(
  userId: string,
  request: SecureSendAllowRequest,
  deps: typeof sendGrantDeps = sendGrantDeps,
): Promise<SecureSendAllowResponse> {
  if (!SEND_KEY.test(request.sendId)) throw new SecurePolicyError('invalid', 'Check the request.');
  const items = await deps.listItems(userId);
  const answers = request.items.map((entry) => {
    const item = items.find((candidate) => candidate.id === entry.itemId);
    if (!item) throw new SecureStoreError('not_found', 'This item is not saved any more.');
    if (!MAIL_KINDS.has(item.kind))
      throw new SecurePolicyError('invalid', 'Only an ID number or a date of birth goes in a mail.');
    const domains = normalizeMailDomains(entry.domains);
    if (!domains.length)
      throw new SecurePolicyError('site', 'Enter the mail domain, for example example.com.');
    return { item, domains };
  });
  if (request.scope === 'always') {
    for (const { item, domains } of answers) {
      await deps.mutation(api.secureDetails.addMailDomains, { userId, itemId: item.id, domains });
      for (const domain of domains)
        await deps.recordUse({ userId, itemId: item.id, outcome: 'allowed_send_always', site: domain });
    }
    return { ok: true, scope: 'always' };
  }
  const allowToken = deps.newToken();
  const granted = await deps.mutation<{ granted: boolean; expiresAt?: number }>(
    api.secureDetails.grantSendOnce,
    {
      userId,
      sendKey: request.sendId,
      tokenHash: sendTokenHash(allowToken),
      grants: answers.flatMap(({ item, domains }) => domains.map((domain) => ({ itemId: item.id, domain }))),
      ttlMs: SEND_GRANT_TTL_MS,
    },
  );
  if (!granted?.granted || !granted.expiresAt)
    throw new SecureStoreError('not_found', 'This item is not saved any more.');
  for (const { item, domains } of answers)
    for (const domain of domains)
      await deps.recordUse({ userId, itemId: item.id, outcome: 'allowed_send_once', site: domain });
  return { ok: true, scope: 'once', allowToken, expiresAt: granted.expiresAt };
}

/** True when the token is this user's "Allow for this send" for this send key, unused and not ended. */
export async function sendTokenValid(
  userId: string,
  token: string,
  sendKey: string,
  deps: Pick<typeof sendGrantDeps, 'query'> = sendGrantDeps,
): Promise<boolean> {
  if (!token || token.length > 200 || !SEND_KEY.test(sendKey)) return false;
  return deps
    .query<boolean>(api.secureDetails.sendTokenValid, { userId, tokenHash: sendTokenHash(token), sendKey })
    .catch(() => false);
}

/** True when an unused "Allow for this send" covers this item and domain for this send. */
export function sendGrantCovers(
  input: { userId: string; itemId: string; domain: string; sendKey: string },
  deps: Pick<typeof sendGrantDeps, 'query'> = sendGrantDeps,
): Promise<boolean> {
  return deps.query<boolean>(api.secureDetails.sendGrantCovers, input).catch(() => false);
}

/** Marks the "Allow for this send" grants of a send as used, after the files are filled. */
export async function consumeSendGrants(
  userId: string,
  sendKey: string,
  deps: Pick<typeof sendGrantDeps, 'mutation'> = sendGrantDeps,
): Promise<void> {
  await deps.mutation(api.secureDetails.consumeSendGrants, { userId, sendKey });
}

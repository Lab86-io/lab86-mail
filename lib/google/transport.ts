// Direct Google transport: identity helpers.
//
// A Google account that talks to Google without Nylas keeps its `accountId`
// (so the corpus, labels, Jev verdicts, and calendar rows stay valid: Nylas v3
// already stores Gmail's own thread, message, and event ids). Only the grant
// id changes. It becomes `google:<random UUID>`, a new id for each connection,
// and `requireNylas()` sends every SDK call with that identifier to the Google
// adapter instead of Nylas. See docs/google-direct-transport.md.
//
// The grant id does not hold the account id: two users can share one
// accountId (a Nylas grant id is the accountId of the first connection, and
// one mailbox can be connected under two users). A lookup by grant id finds
// exactly one connection; a lookup by account uses (userId, accountId).

import { randomUUID } from 'node:crypto';

export const GOOGLE_GRANT_PREFIX = 'google:';

export function isGoogleDirectGrant(id: unknown): id is string {
  return (
    typeof id === 'string' && id.startsWith(GOOGLE_GRANT_PREFIX) && id.length > GOOGLE_GRANT_PREFIX.length
  );
}

/** A new grant id for one direct Google connection. */
export function newGoogleDirectGrantId(uuid: () => string = randomUUID): string {
  const id = String(uuid() || '').trim();
  if (!id) throw new Error('A random id is required for a direct Google grant.');
  return `${GOOGLE_GRANT_PREFIX}${id}`;
}

/** New Google connections use the direct transport only when this flag is on. */
export function isGoogleDirectEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.LAB86_GOOGLE_DIRECT === '1';
}

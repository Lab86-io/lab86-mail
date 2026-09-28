// Direct Google transport: identity helpers.
//
// A Google account that talks to Google without Nylas keeps its `accountId`
// (so the corpus, labels, Jev verdicts, and calendar rows stay valid: Nylas v3
// already stores Gmail's own thread, message, and event ids). Only the grant
// id changes. It becomes `google:<accountId>`, and `requireNylas()` sends
// every SDK call with that identifier to the Google adapter instead of Nylas.
// See docs/google-direct-transport.md.

export const GOOGLE_GRANT_PREFIX = 'google:';

export function isGoogleDirectGrant(id: unknown): id is string {
  return (
    typeof id === 'string' && id.startsWith(GOOGLE_GRANT_PREFIX) && id.length > GOOGLE_GRANT_PREFIX.length
  );
}

export function googleDirectGrantId(accountId: string): string {
  const trimmed = String(accountId || '').trim();
  if (!trimmed) throw new Error('An account id is required for a direct Google grant.');
  return `${GOOGLE_GRANT_PREFIX}${trimmed}`;
}

export function accountIdFromGoogleGrant(grantId: string): string {
  if (!isGoogleDirectGrant(grantId)) throw new Error('Not a direct Google grant id.');
  return grantId.slice(GOOGLE_GRANT_PREFIX.length);
}

/** New Google connections use the direct transport only when this flag is on. */
export function isGoogleDirectEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.LAB86_GOOGLE_DIRECT === '1';
}

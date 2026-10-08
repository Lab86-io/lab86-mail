import { auth, reverificationError } from '@clerk/nextjs/server';
import { IDENTITY_CHECK_MINUTES, VERIFY_IDENTITY_CODE } from './contract';

// The identity check before a saved value goes somewhere new
// (docs/albatross-secure-store.md): "Allow once", "Always on this site", and a
// new site in Settings. The session's first factor must be verified within
// IDENTITY_CHECK_MINUTES. Clerk keeps that age in the session token (`fva`),
// for the web cookie and for the native Bearer token alike.

export const IDENTITY_CHECK = { level: 'first_factor', afterMinutes: IDENTITY_CHECK_MINUTES } as const;

type SessionReader = () => Promise<{
  userId: string | null;
  has: (input: { reverification: typeof IDENTITY_CHECK }) => boolean;
}>;

/** True when the current session verified its first factor recently. */
export async function identityRecentlyChecked(
  readSession: SessionReader = auth as unknown as SessionReader,
): Promise<boolean> {
  const session = await readSession();
  if (!session.userId) return false;
  try {
    return session.has({ reverification: IDENTITY_CHECK });
  } catch {
    return false;
  }
}

/**
 * The 403 answer that asks for the check. The body is Clerk's reverification
 * error, so the web `useReverification` hook opens Clerk's modal and retries.
 * `code` lets the native apps tell this answer from other refusals.
 */
export function verifyIdentityResponse() {
  return Response.json(
    {
      ...reverificationError(IDENTITY_CHECK),
      ok: false,
      code: VERIFY_IDENTITY_CODE,
      error: 'Albatross needs one more check first. Then try again.',
    },
    { status: 403, headers: { 'cache-control': 'no-store' } },
  );
}

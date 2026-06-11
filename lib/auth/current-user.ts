import { auth, clerkClient } from '@clerk/nextjs/server';
import { isClerkConfigured } from '@/lib/hosted/env';

export interface CurrentUser {
  userId: string;
  email: string;
  name: string;
  source: 'clerk';
}

// Profile lookups hit Clerk's API over the network. Every tool call, search,
// and thread fetch resolves the current user, so without this cache each UI
// interaction pays a full Clerk round-trip before doing any real work.
// Session validity still comes from auth() on every request — this only
// caches the (rarely changing) name/email profile fields.
const profileCache = new Map<string, { user: CurrentUser; at: number }>();
const PROFILE_CACHE_TTL_MS = 5 * 60_000;
const PROFILE_CACHE_MAX = 1_000;

export async function getCurrentUser(): Promise<CurrentUser | null> {
  if (!isClerkConfigured()) return null;

  const session = await auth();
  if (!session.userId) return null;

  const cached = profileCache.get(session.userId);
  if (cached && Date.now() - cached.at < PROFILE_CACHE_TTL_MS) {
    profileCache.delete(session.userId);
    profileCache.set(session.userId, cached);
    return cached.user;
  }

  const client = await clerkClient();
  const clerkUser = await client.users.getUser(session.userId).catch(() => null);
  const primaryEmail =
    clerkUser?.emailAddresses.find((email) => email.id === clerkUser.primaryEmailAddressId)?.emailAddress ||
    clerkUser?.emailAddresses[0]?.emailAddress ||
    '';
  const user: CurrentUser = {
    userId: session.userId,
    email: primaryEmail,
    name: clerkUser?.fullName || clerkUser?.firstName || primaryEmail || session.userId,
    source: 'clerk',
  };
  // Only cache real profiles — a failed Clerk fetch must not pin fallbacks.
  if (clerkUser) {
    if (profileCache.size >= PROFILE_CACHE_MAX) {
      const oldest = profileCache.keys().next().value;
      if (oldest) profileCache.delete(oldest);
    }
    profileCache.delete(session.userId);
    profileCache.set(session.userId, { user, at: Date.now() });
  }
  return user;
}

export async function requireCurrentUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new AuthRequiredError('Sign in required.');
  }
  return user;
}

export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

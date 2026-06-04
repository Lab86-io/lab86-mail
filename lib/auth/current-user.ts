import { auth, clerkClient } from '@clerk/nextjs/server';
import { isClerkConfigured } from '@/lib/hosted/env';

export interface CurrentUser {
  userId: string;
  email: string;
  name: string;
  source: 'clerk' | 'legacy';
}

const LEGACY_USER: CurrentUser = {
  userId: 'legacy:local',
  email: process.env.LAB86_MAIL_LEGACY_EMAIL || 'local@lab86.dev',
  name: process.env.LAB86_MAIL_LEGACY_NAME || 'Local User',
  source: 'legacy',
};

export async function getCurrentUser(options: { allowLegacy?: boolean } = {}): Promise<CurrentUser | null> {
  const allowLegacy = options.allowLegacy !== false;
  if (!isClerkConfigured()) return allowLegacy ? LEGACY_USER : null;

  const session = await auth();
  if (!session.userId) return null;

  const client = await clerkClient();
  const clerkUser = await client.users.getUser(session.userId).catch(() => null);
  const primaryEmail =
    clerkUser?.emailAddresses.find((email) => email.id === clerkUser.primaryEmailAddressId)?.emailAddress ||
    clerkUser?.emailAddresses[0]?.emailAddress ||
    '';
  return {
    userId: session.userId,
    email: primaryEmail,
    name: clerkUser?.fullName || clerkUser?.firstName || primaryEmail || session.userId,
    source: 'clerk',
  };
}

export async function requireCurrentUser(options: { allowLegacy?: boolean } = {}): Promise<CurrentUser> {
  const user = await getCurrentUser(options);
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

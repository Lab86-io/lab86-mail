import { auth, clerkClient } from '@clerk/nextjs/server';
import { isClerkConfigured } from '@/lib/hosted/env';

export interface CurrentUser {
  userId: string;
  email: string;
  name: string;
  source: 'clerk';
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  if (!isClerkConfigured()) return null;

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

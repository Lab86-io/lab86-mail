'use client';

import { useAuth } from '@clerk/nextjs';
import { useEffect, useState } from 'react';
import { clearStorageAfterSessionEnd, createSessionEndWatcher } from '@/lib/auth/sign-out-storage';

/**
 * Clears app storage when the session ends by a path that the app does not control: the sign-out
 * item in Clerk's UserButton menu, a sign-out in another tab, or a revoked session. Clerk's
 * UserButton has no sign-out callback, so this watches the auth state. Mount it only inside
 * ClerkProvider.
 */
export function SignOutStorageGuard() {
  const { isLoaded, userId } = useAuth();
  const [watch] = useState(() => createSessionEndWatcher(() => void clearStorageAfterSessionEnd()));

  useEffect(() => {
    watch({ isLoaded, userId });
  }, [watch, isLoaded, userId]);

  return null;
}

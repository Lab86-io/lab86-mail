'use client';

import { useAuth } from '@clerk/nextjs';
import { MutationCache, QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ConvexProviderWithAuth, ConvexReactClient } from 'convex/react';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PendingSendProvider } from '@/components/compose/PendingSendProvider';
import { bindBriefEditionCache } from '@/lib/brief/edition-cache';
import { createMutationErrorFallback } from '@/lib/shell/mutation-errors';
import { SignOutStorageGuard } from './SignOutStorageGuard';

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const convex = new ConvexReactClient(convexUrl || 'http://127.0.0.1:3210', {
  logger: Boolean(convexUrl),
  skipConvexDeploymentUrlCheck: !convexUrl,
});

// Without Clerk nobody is signed in. Convex readers still get an auth answer.
const SIGNED_OUT_CONVEX_AUTH = {
  isLoading: false,
  isAuthenticated: false,
  fetchAccessToken: async () => null,
};
const signedOutConvexAuth = () => SIGNED_OUT_CONVEX_AUTH;

/**
 * The latest edition on disk, for this signed-in user only. It waits for Clerk
 * to name the user, so a second person on this browser never sees the first
 * person's mail.
 */
function BriefEditionPersistence() {
  const client = useQueryClient();
  const { isLoaded, userId } = useAuth();
  useEffect(() => {
    if (!isLoaded || !userId) return;
    return bindBriefEditionCache(client, userId);
  }, [client, isLoaded, userId]);
  return null;
}

export function QueryProvider({
  children,
  clerkEnabled,
}: {
  children: React.ReactNode;
  clerkEnabled: boolean;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        // A failed change must never be silent. Mutations with their own
        // onError keep their own message; this covers the rest.
        mutationCache: new MutationCache({
          onError: createMutationErrorFallback((message) => toast.error(message)),
        }),
        defaultOptions: {
          queries: {
            // Keep recently viewed mail warm. Freshness-sensitive views still
            // set their own polling/refresh behavior, but focus changes should
            // not make the whole UI feel like it is reloading.
            staleTime: 60_000,
            gcTime: 30 * 60_000,
            refetchOnWindowFocus: false,
            // Same for regaining network - we may have missed mail offline.
            refetchOnReconnect: true,
            retry: 1,
          },
        },
      }),
  );
  const content = (
    <QueryClientProvider client={client}>
      {/* ClerkProvider wraps this tree only when clerkEnabled is true. */}
      {clerkEnabled ? <SignOutStorageGuard /> : null}
      {clerkEnabled ? <BriefEditionPersistence /> : null}
      <PendingSendProvider>{children}</PendingSendProvider>
    </QueryClientProvider>
  );
  if (!convexUrl || !clerkEnabled || !clerkPublishableKey)
    return (
      <ConvexProviderWithAuth client={convex} useAuth={signedOutConvexAuth}>
        {content}
      </ConvexProviderWithAuth>
    );
  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      {content}
    </ConvexProviderWithClerk>
  );
}

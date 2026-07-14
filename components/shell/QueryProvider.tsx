'use client';

import { useAuth } from '@clerk/nextjs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConvexProvider, ConvexReactClient } from 'convex/react';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import { useState } from 'react';

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const convex = new ConvexReactClient(convexUrl || 'http://127.0.0.1:3210', {
  logger: Boolean(convexUrl),
  skipConvexDeploymentUrlCheck: !convexUrl,
});

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
  const content = <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  if (!convexUrl || !clerkEnabled || !clerkPublishableKey)
    return <ConvexProvider client={convex}>{content}</ConvexProvider>;
  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      {content}
    </ConvexProviderWithClerk>
  );
}

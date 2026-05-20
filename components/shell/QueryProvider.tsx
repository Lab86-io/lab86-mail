'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Default short stale window so per-query staleTime overrides on
            // long-lived data (photos, labels) still feel snappy, while
            // freshness-sensitive views like the inbox set their own.
            staleTime: 15_000,
            // Tabbing back to the app is the most common "did I get new mail?"
            // signal — let React Query refetch every active query on focus.
            refetchOnWindowFocus: true,
            // Same for regaining network — we may have missed mail offline.
            refetchOnReconnect: true,
            retry: 1,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

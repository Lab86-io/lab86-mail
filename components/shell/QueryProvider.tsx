'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export function QueryProvider({ children }: { children: React.ReactNode }) {
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
            // Same for regaining network — we may have missed mail offline.
            refetchOnReconnect: true,
            retry: 1,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

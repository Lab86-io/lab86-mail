import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { PreparedWork } from '../../components/report/PreparedWork';
import { ContentSettings } from '../../components/settings/ContentSettings';

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
(window as any).__refreshPreparations = () => client.invalidateQueries({ queryKey: ['brief-preparations'] });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <main className="mx-auto max-w-[780px] space-y-12 p-4 sm:p-8">
      <header>
        <p className="text-xs text-[var(--color-text-muted)]">
          Synthetic preview · Actual product components
        </p>
        <h1 className="mt-2 font-serif text-3xl">Your Daily Brief</h1>
        <p className="mt-3 text-sm text-[var(--color-text-muted)]">
          Monday, September 21 · Updated throughout the day
        </p>
      </header>
      <PreparedWork />
      <div className="border-t border-[var(--color-border)] pt-8">
        <ContentSettings />
      </div>
    </main>
  </QueryClientProvider>,
);

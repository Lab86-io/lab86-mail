/** Synthetic only. No account data, AI calls, or external writes. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { BriefCanvas } from '../../components/report/brief-canvas/BriefCanvas';

const params = new URLSearchParams(location.search);
if (params.has('dark')) document.documentElement.classList.add('dark');
const value = await fetch(`/__document${location.search}`).then((response) => response.json());
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const originalFetch = window.fetch;
window.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes('/api/briefs/components')) return originalFetch(input, init);
  if (url.includes('/briefs/resolve')) return Response.json({ ok: true, entities: [] });
  if (url.includes('/narrative')) return Response.json({ enabled: false });
  if (url.includes('/content')) return Response.json({ items: [] });
  if (url.includes('/tools/') || url.includes('/briefs/events'))
    return Response.json({ ok: true, result: {} });
  return Response.json({ error: 'Synthetic preview only' }, { status: 404 });
};

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <main className="mx-auto min-h-screen max-w-[1180px] bg-[var(--color-content)] text-[var(--color-text)]">
      <header className="px-6 pt-8 pb-3 sm:px-14">
        <p className="text-[11px] uppercase tracking-widest text-[var(--color-text-muted)]">
          Monday, September 21 · Synthetic edition
        </p>
        <h1 className="mt-2 font-display text-4xl font-semibold">Your daily review</h1>
      </header>
      <BriefCanvas
        reportId={params.has('catalogue') ? 'catalogue' : 'preview'}
        value={value}
        embedded
        liveSections={!params.has('history')}
      />
    </main>
    <Toaster />
  </QueryClientProvider>,
);

/** Synthetic-only interaction fixture. Every data request is intercepted. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { BriefCanvas } from '../../components/report/brief-canvas/BriefCanvas';
import { useClientStore } from '../../lib/client-state';
import type { NarrativeWorkspace } from '../../lib/narrative/workspace';
import { letterBriefDocumentFixture } from '../../lib/shared/brief-document-fixtures';

const at = letterBriefDocumentFixture.generatedAt;
const date = Date.UTC(2026, 8, 9, 13);
const workspace: NarrativeWorkspace = {
  enabled: true,
  stamp: 'a'.repeat(64),
  mode: 'generated',
  threads: [
    {
      id: 'meeting',
      title: 'Bring CardHunt across the line',
      summary:
        'Yesterday’s planning notes and the integration PR point to the same next move: review the remaining checks. The PR is open; the release is not confirmed.',
      nextStep: 'Review the integration checks before deciding whether to merge.',
      sources: [
        {
          id: 'meeting',
          title: 'CardHunt integration review',
          excerpt: 'The team agreed to finish the review before choosing a release date.',
          kind: 'meeting',
          occurredAt: date - 86400000,
          trust: 'observed',
          href: '/narrative?id=meeting',
          originalUrl: 'https://example.test/meeting',
        },
        {
          id: 'pr',
          title: 'Integration checks · PR #42',
          excerpt: 'Open pull request with two review comments still unresolved.',
          kind: 'development',
          occurredAt: date,
          trust: 'observed',
          href: '/narrative?id=pr',
        },
      ],
      work: {
        id: 'cardhunt',
        title: 'Finish the CardHunt integration',
        state: 'active',
        guided: true,
        nextStep: 'Review the two remaining comments',
      },
    },
    {
      id: 'email',
      title: 'Close the loop with Maya',
      summary: 'Maya asked for feedback on the review deck. There is no recorded reply yet.',
      nextStep: 'Read the deck and decide what feedback to send.',
      sources: [
        {
          id: 'email',
          title: 'Review deck for Thursday',
          excerpt: 'Could you send your notes before tomorrow’s product review?',
          kind: 'mail',
          occurredAt: date,
          trust: 'observed',
          href: '/narrative?id=email',
        },
      ],
    },
  ],
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
client.setQueryData(['narrative', 'brief', at], {
  enabled: true,
  entry: {
    _id: 'brief',
    updatedAt: date,
    model: 'glm',
    sourceIds: ['meeting', 'pr', 'email'],
    text: 'CardHunt has a clear next move. Yesterday’s review narrowed the remaining work to two integration checks; your open PR brings those into focus. Start there, then leave room to get Maya your notes before tomorrow’s review.',
  },
});
client.setQueryData(['narrative', 'workspace', at, date], workspace);
client.setQueryData(['brief', 'weather'], {
  weather: {
    location: 'Rochester, NY',
    unit: '°F',
    current: { temp: 72, condition: 'Partly cloudy', high: 77, low: 58 },
    daily: [{ precipChance: 20 }],
    source: 'Open-Meteo',
    attributionURL: 'https://open-meteo.com/',
  },
  asOf: date,
});
const requests: unknown[] = [];
(globalThis as any).__todayRequests = requests;
(globalThis as any).__todayState = () => ({
  guidedWorkId: useClientStore.getState().guidedWorkId,
  selectedWorkId: useClientStore.getState().selectedWorkId,
  captureSeed: useClientStore.getState().captureSeed,
});
globalThis.fetch = (async (url, options) => {
  const path = String(url);
  if (path.includes('/api/narrative/workspace')) {
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body));
      requests.push(body);
      return Response.json(body.action === 'generate' ? workspace : { ok: true });
    }
    return Response.json(workspace);
  }
  if (path.includes('/api/narrative?')) return Response.json(client.getQueryData(['narrative', 'brief', at]));
  if (path.includes('/api/brief/weather')) return Response.json(client.getQueryData(['brief', 'weather']));
  if (path.includes('/api/albatross/work/') && path.endsWith('/state')) {
    requests.push(JSON.parse(String(options?.body)));
    return Response.json({ ok: true });
  }
  // Brief hydration may ask for synthetic entities; no real providers allowed.
  return Response.json({ entities: [], error: 'Synthetic fixture only' }, { status: 404 });
}) as typeof fetch;
function Preview() {
  const workId = useClientStore((s) => s.selectedWorkId);
  return (
    <QueryClientProvider client={client}>
      <main className="mx-auto max-w-3xl px-5 py-8 text-[var(--color-text)]">
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">Synthetic account · interaction preview</p>
        <h1 className="mb-8 font-display text-3xl">Wednesday, September 9</h1>
        {workId ? <p role="status">Opened work: {workId}</p> : null}
        <BriefCanvas value={letterBriefDocumentFixture} embedded noiseCount={42} />
      </main>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);

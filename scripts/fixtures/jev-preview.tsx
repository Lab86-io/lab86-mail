import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { BriefMailBacklog } from '../../components/report/BriefMailBacklog';
import { JevSection, JevSettingsPanel } from '../../components/settings/JevSection';
import { JevMailDetails } from '../../components/thread/JevMailDetails';
import { DEFAULT_JEV_PREFERENCES } from '../../lib/jev/contract';
import { assessment } from '../../tests/fixtures/jev';

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const setup = new URL(location.href).searchParams.has('setup');
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <main className="mx-auto max-w-[780px] p-4 sm:p-8">
      {setup ? (
        <JevSettingsPanel
          state={{
            preferences: DEFAULT_JEV_PREFERENCES,
            corrections: [],
            revision: 0,
            configured: false,
            configurationMessage: 'Connect your OpenRouter key to start classifying.',
            model: 'typesafe/jev-1.13',
            counts: { accepted: 0, uncertain: 0, pending: 0, unavailable: 0 },
            sampledThreads: 0,
            sampleLimit: 500,
            lastEvaluatedAt: null,
          }}
          busy={false}
          onSave={() => undefined}
          onReprocess={() => undefined}
        />
      ) : (
        <JevSection />
      )}
      <section className="mt-10 border-t border-[var(--color-border)] pt-6" aria-label="Reader preview">
        <h2 className="mb-4 text-sm font-semibold">Budget approval</h2>
        <JevMailDetails assessment={assessment()} />
      </section>
      <BriefMailBacklog
        items={[
          {
            account: 'account-a',
            threadId: 'older-request',
            subject: 'Older request still needs a reply',
            whyItMatters: 'An unresolved request needs your reply.',
          },
        ]}
        onOpen={(account, threadId) => {
          document.getElementById('opened-thread')!.textContent = `${account}:${threadId}`;
        }}
      />
      <p id="opened-thread" role="status" />
    </main>
  </QueryClientProvider>,
);

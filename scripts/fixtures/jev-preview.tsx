import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MailNavView } from '../../components/inbox/MailNav';
import { BriefMailBacklog } from '../../components/report/BriefMailBacklog';
import { JevSection, JevSettingsPanel } from '../../components/settings/JevSection';
import { JevMailDetails } from '../../components/thread/JevMailDetails';
import { DEFAULT_JEV_PREFERENCES } from '../../lib/jev/contract';
import { assessment } from '../../tests/fixtures/jev';

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const setup = new URL(location.href).searchParams.has('setup');
function NavigationPreview() {
  const [category, setCategory] = useState<string | null>('main');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  return (
    <section aria-label="Mail navigation preview" className="mb-8 border border-[var(--color-border)]">
      <MailNavView
        query={query}
        smartCategory={category}
        customLabels={[{ _id: 'budget', name: 'Budget' }]}
        counts={{
          main: { unread: 12, attention: true },
          needs_reply: { unread: 4, attention: true },
          noise: { unread: 99, attention: false },
        }}
        onCategory={(value) => {
          setCategory(value);
          setQuery('');
        }}
        onFolder={(value) => {
          setCategory(null);
          setQuery(value);
        }}
        onCompose={() => setNotice('Compose opened')}
        onSettings={() => setNotice('Category settings opened')}
      />
      <p className="p-3 text-xs text-[var(--color-text-muted)]" data-mail-preview-state>
        {category || query}
      </p>
      <p role="status">{notice}</p>
    </section>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <main className="mx-auto max-w-[780px] p-4 sm:p-8">
      <NavigationPreview />
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

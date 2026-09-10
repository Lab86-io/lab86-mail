/** Actual document owners and editors against loopback synthetic transport only. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentEditor, GoogleDocumentEditor } from '../../components/files/DocumentEditor';
import { TooltipProvider } from '../../components/ui/tooltip';

function Preview() {
  const [selected, setSelected] = useState(new URLSearchParams(location.search).get('kind') || 'doc');
  return (
    <div className="h-dvh bg-[var(--color-bg)] text-[var(--color-text)]">
      {selected === 'google' ? (
        <GoogleDocumentEditor
          source={{
            connectionId: 'synthetic',
            fileId: 'google',
            mimeType: 'application/vnd.google-apps.document',
          }}
          onClose={() => setSelected('')}
        />
      ) : selected ? (
        <DocumentEditor key={selected} documentId={selected} onClose={() => setSelected('')} />
      ) : (
        <div className="flex gap-4 p-8">
          <button type="button" onClick={() => setSelected('doc')}>
            Open document
          </button>
          <button type="button" onClick={() => setSelected('deck')}>
            Open presentation
          </button>
        </div>
      )}
    </div>
  );
}
const client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <TooltipProvider>
      <Preview />
    </TooltipProvider>
  </QueryClientProvider>,
);

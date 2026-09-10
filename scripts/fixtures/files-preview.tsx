/** Synthetic data only. Never connects to a provider or account. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { FilesSurface } from '../../components/files/FilesSurface';
import { MobileNavigation } from '../../components/shell/MobileNavigation';
import { SidebarProvider } from '../../components/ui/sidebar';
import { TooltipProvider } from '../../components/ui/tooltip';
import { createDefaultDocumentModel } from '../../lib/documents/model';

const mode = new URLSearchParams(location.search).get('scenario');
const calls: string[] = [];
(globalThis as any).__filesRequests = calls;
const connection = {
  connectionId: 'drive',
  provider: 'google_drive',
  status: 'connected',
  accountEmail: 'alexandra.long-name@example.test',
};
const file = (id: string, name: string, extra = {}) => ({
  id,
  name,
  provider: 'google_drive',
  connectionId: 'drive',
  mimeType: 'application/pdf',
  modifiedAt: Date.UTC(2026, 8, 9),
  size: 23000,
  webUrl: 'https://example.test/file',
  isFolder: false,
  ...extra,
});
const documents = [
  {
    documentId: 'doc',
    title: 'Release checklist',
    kind: 'doc',
    updatedAt: Date.UTC(2026, 8, 8),
    currentRevision: 1,
    model: createDefaultDocumentModel('doc', 'fixture'),
  },
];
const editorFile = {
  kind: 'doc',
  title: 'Project decision memo',
  providerVersion: '9',
  webUrl: 'https://docs.google.com/document/d/fixture/edit',
  model: {
    kind: 'doc',
    version: 1,
    blocks: [
      {
        id: 'p',
        type: 'paragraph',
        text: 'Source paragraph. Edit this synthetic draft to exercise save recovery.',
      },
    ],
  },
  editability: {
    editable: mode !== 'readonly',
    reason: 'Preview only: the original includes a table that cannot yet be preserved.',
  },
};
if (mode === 'readonly' || mode === 'conflict' || mode === 'saved')
  history.replaceState(
    null,
    '',
    `?scenario=${mode}&view=files&provider=google_drive&connection=drive&file=fixture&mime=application%2Fvnd.google-apps.document`,
  );
globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input), location.origin);
  calls.push(`${init?.method || 'GET'} ${url.pathname}${url.search}`);
  if (url.pathname === '/api/files/status')
    return Response.json({
      ok: true,
      connections: mode === 'empty' ? [] : [connection],
      providers: [{ id: 'google_drive', label: 'Google Drive', configured: true }],
      icloud: { mode: 'device_folder' },
    });
  if (url.pathname === '/api/agent/uploads') return Response.json({ ok: true, files: [] });
  if (url.pathname === '/api/files/google/editor') {
    if (init?.method === 'PATCH') {
      if (mode === 'conflict')
        return Response.json({ ok: false, error: 'The original changed.' }, { status: 409 });
      const submitted = JSON.parse(String(init?.body));
      return Response.json({
        ok: true,
        file: {
          ...editorFile,
          model: submitted.model,
          title: submitted.title,
          providerVersion: '10',
          editability: undefined,
        },
      });
    }
    return Response.json({ ok: true, file: editorFile });
  }
  if (url.pathname === '/api/documents')
    return Response.json({ ok: true, documents: mode === 'empty' ? [] : documents });
  if (url.pathname === '/api/files/library')
    return Response.json({
      ok: true,
      items:
        mode === 'empty' ||
        url.searchParams.get('kind') === 'uploads' ||
        (url.searchParams.get('search') &&
          !'release checklist'.includes(url.searchParams.get('search')!.toLowerCase()))
          ? []
          : [
              {
                id: 'doc',
                documentId: 'doc',
                name: 'Release checklist',
                provider: 'albatross',
                mimeType: 'application/x-albatross-document',
                modifiedAt: Date.UTC(2026, 8, 8),
                isFolder: false,
              },
            ],
      nextCursor: undefined,
    });
  if (url.pathname === '/api/files/browse') {
    if (mode === 'error')
      return Response.json({ ok: false, error: 'Google Drive needs to reconnect.' }, { status: 409 });
    if (url.searchParams.has('cursor'))
      return Response.json({ ok: true, items: [file('last', 'Second-page source.pdf')] });
    if (url.searchParams.has('folderId'))
      return Response.json({ ok: true, items: [file('nested', 'Inside the project.pdf')] });
    if (url.searchParams.get('q'))
      return Response.json({
        ok: true,
        items: url.searchParams.get('q') === 'absent' ? [] : [file('search', 'Matching research.pdf')],
      });
    return Response.json({
      ok: true,
      items: [
        file('folder', 'Project material', { isFolder: true }),
        file(
          'long',
          'A very long proposal title for a cross-platform integration that should never push the actions off the screen.pdf',
        ),
        file('image', 'Reference image.png', { mimeType: 'image/png', thumbnailUrl: '/missing.png' }),
      ],
      nextCursor: 'page-two',
    });
  }
  return Response.json({ ok: false, error: 'Synthetic fixture: unexpected request' }, { status: 404 });
}) as typeof fetch;
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <SidebarProvider>
        <div className="flex h-dvh w-full min-w-0 flex-col text-[var(--color-text)]">
          <div className="shrink-0 md:hidden">
            <MobileNavigation
              onSearch={() => {
                (globalThis as any).__searchOpened = true;
              }}
            />
          </div>
          <div className="min-h-0 flex-1">
            <FilesSurface />
          </div>
        </div>
      </SidebarProvider>
    </TooltipProvider>
  </QueryClientProvider>,
);

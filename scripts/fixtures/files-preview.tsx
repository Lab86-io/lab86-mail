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
const submittedBodies: unknown[] = [];
(globalThis as any).__filesBodies = submittedBodies;
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
const ownedKind = mode === 'owned-sheet' ? 'sheet' : mode === 'owned-deck' ? 'deck' : 'doc';
let ownedDocument = {
  documentId: 'doc',
  kind: ownedKind,
  title: 'Project decision memo',
  model:
    ownedKind === 'doc'
      ? {
          kind: 'doc',
          version: 1,
          blocks: [
            { id: 'heading', type: 'heading', level: 1, text: 'Decision and next steps' },
            {
              id: 'paragraph',
              type: 'paragraph',
              text: 'A useful working document keeps the decision, its evidence, and the next step together.',
            },
            { id: 'second-heading', type: 'heading', level: 2, text: 'What changed this week' },
            {
              id: 'second-paragraph',
              type: 'paragraph',
              text: 'A calmer workspace makes room for the work.',
            },
          ],
        }
      : createDefaultDocumentModel(ownedKind, 'fixture'),
  currentRevision: 2,
  sourceRefs: [],
  suggestions: [
    {
      suggestionId: 'stale-suggestion',
      documentId: 'doc',
      title: 'An earlier idea',
      description: 'This proposal must not overwrite a newer revision.',
      proposedModel: createDefaultDocumentModel(ownedKind, 'proposal'),
      baseRevision: 1,
      status: 'proposed',
      createdAt: 1,
    },
    {
      suggestionId: 'current-suggestion',
      documentId: 'doc',
      title: 'A clearer memo',
      description: 'Clarify the decision and preserve the supporting context.',
      proposedModel: createDefaultDocumentModel(ownedKind, 'proposal'),
      baseRevision: 2,
      status: 'proposed',
      createdAt: 2,
    },
  ],
  createdAt: Date.UTC(2026, 8, 8),
  updatedAt: Date.UTC(2026, 8, 9),
};
if (mode?.startsWith('owned')) history.replaceState(null, '', `?scenario=${mode}&view=files&document=doc`);
if (mode === 'readonly' || mode === 'conflict' || mode === 'saved')
  history.replaceState(
    null,
    '',
    `?scenario=${mode}&view=files&provider=google_drive&connection=drive&file=fixture&mime=application%2Fvnd.google-apps.document`,
  );
globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input), location.origin);
  calls.push(`${init?.method || 'GET'} ${url.pathname}${url.search}`);
  if (url.pathname === '/api/office') return Response.json({ ok: true, enabled: false, files: [] });
  if (url.pathname === '/api/documents/doc') {
    if (init?.method === 'PATCH') {
      const submitted = JSON.parse(String(init?.body));
      submittedBodies.push(submitted);
      if (mode === 'owned-conflict' || mode === 'owned-error')
        return Response.json(
          {
            ok: false,
            error: mode === 'owned-conflict' ? 'Another editor saved changes.' : 'Save unavailable.',
          },
          { status: mode === 'owned-conflict' ? 409 : 503 },
        );
      ownedDocument = {
        ...ownedDocument,
        title: submitted.title,
        model: submitted.model,
        currentRevision: ownedDocument.currentRevision + 1,
      };
    } else if ((globalThis as any).__failNextFileRead) {
      (globalThis as any).__failNextFileRead = false;
      return Response.json(
        { ok: false, error: 'The saved copy is temporarily unavailable.' },
        { status: 503 },
      );
    }
    return Response.json({ ok: true, document: ownedDocument });
  }
  if (url.pathname === '/api/documents/doc/revisions') {
    if (init?.method === 'POST') {
      submittedBodies.push(JSON.parse(String(init?.body)));
      await new Promise<void>((resolve) => {
        (globalThis as any).__releaseFileAction = resolve;
      });
      ownedDocument = { ...ownedDocument, title: 'Restored decision memo', currentRevision: 3 };
      return Response.json({ ok: true });
    }
    return Response.json({
      ok: true,
      revisions: [
        {
          revision: ownedDocument.currentRevision,
          title: ownedDocument.title,
          reason: 'Current saved copy',
          actor: 'user',
          createdAt: ownedDocument.updatedAt,
        },
        {
          revision: 1,
          title: 'Original decision memo',
          reason: 'Created document',
          actor: 'user',
          createdAt: ownedDocument.createdAt,
        },
      ],
    });
  }
  if (url.pathname === '/api/documents/doc/suggestions/current-suggestion') {
    submittedBodies.push(JSON.parse(String(init?.body)));
    await new Promise<void>((resolve) => {
      (globalThis as any).__releaseFileAction = resolve;
    });
    ownedDocument = {
      ...ownedDocument,
      title: 'AI-reviewed decision memo',
      currentRevision: 3,
      suggestions: ownedDocument.suggestions.filter(
        (suggestion) => suggestion.suggestionId !== 'current-suggestion',
      ),
    };
    return Response.json({ ok: true });
  }
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

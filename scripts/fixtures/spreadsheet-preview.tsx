/** Synthetic data only. Never connects to a provider or account. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { FilesSurface } from '../../components/files/FilesSurface';
import { SidebarProvider } from '../../components/ui/sidebar';
import { TooltipProvider } from '../../components/ui/tooltip';
import { createDefaultDocumentModel } from '../../lib/documents/model';

const scenario = new URLSearchParams(location.search).get('scenario') || 'grid';
const calls: string[] = [];
const bodies: Array<{ url: string; body: any }> = [];
const state = {
  calls,
  bodies,
  documents: new Map<string, any>(),
  imported: null as null | {
    size: number;
    name: string;
    modelVersion: number;
    warnings: string[];
    sha256: string;
  },
  releaseSuggestion: null as null | (() => void),
};
(globalThis as any).__sheet = state;

async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function ownedDocument(documentId: string, title: string, model: any, extra: Record<string, unknown> = {}) {
  return {
    documentId,
    kind: 'sheet',
    title,
    model,
    currentRevision: 2,
    sourceRefs: [],
    suggestions: [],
    createdAt: Date.UTC(2026, 8, 8),
    updatedAt: Date.UTC(2026, 8, 9),
    ...extra,
  };
}

const gridModel = {
  kind: 'sheet',
  version: 1,
  activeSheetId: 'plan',
  sheets: [
    {
      id: 'plan',
      name: 'Plan',
      rowCount: 100,
      columnCount: 26,
      cells: {
        A1: { value: 'Item' },
        B1: { value: 'Amount' },
        A2: { value: 'Design' },
        B2: { value: 1200 },
        A3: { value: 'Build' },
        B3: { value: 3400 },
        A4: { value: 'Total' },
        B4: { formula: 'SUM(B2:B3)' },
      },
    },
    { id: 'notes', name: 'Notes', rowCount: 50, columnCount: 10, cells: { A1: { value: 'Assumptions' } } },
  ],
};

state.documents.set('sheet-a', ownedDocument('sheet-a', 'Launch budget', gridModel));
state.documents.set(
  'sheet-b',
  ownedDocument('sheet-b', 'Second workbook', createDefaultDocumentModel('sheet', 'b')),
);
state.documents.set(
  'memo',
  ownedDocument('memo', 'Decision memo', createDefaultDocumentModel('doc', 'memo'), { kind: 'doc' }),
);
if (scenario === 'suggest') {
  state.documents.get('sheet-a').suggestions = [
    {
      suggestionId: 'fill-total',
      documentId: 'sheet-a',
      title: 'Add a contingency line',
      description: 'Adds a 10% contingency row and extends the total.',
      proposedModel: {
        kind: 'sheet-changes',
        version: 1,
        changes: [
          { sheet: 'Plan', cell: 'A5', content: 'Contingency' },
          { sheet: 'Plan', cell: 'B5', content: '=B4*0.1' },
          { sheet: 'Plan', cell: 'A6', content: 'Grand total' },
          { sheet: 'Plan', cell: 'B6', content: '=B4+B5' },
        ],
      },
      baseRevision: 2,
      status: 'proposed',
      createdAt: 3,
    },
  ];
}
if (scenario === 'imported') {
  state.documents.get('sheet-a').importSource = {
    format: 'xlsx',
    filename: 'launch-budget.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 8210,
    sha256: 'synthetic',
    storageId: 'storage',
    warnings: ['Conditional format on B2:B3 uses an unsupported rule and was dropped.'],
    importedAt: Date.UTC(2026, 8, 9),
    revision: 1,
  };
}

const openDocument = scenario === 'list' || scenario === 'import' ? null : 'sheet-a';
history.replaceState(
  null,
  '',
  `?scenario=${scenario}&view=files${openDocument ? `&document=${openDocument}` : ''}`,
);

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input), location.origin);
  const method = init?.method || 'GET';
  calls.push(`${method} ${url.pathname}${url.search}`);
  if (url.pathname.startsWith('/vendor/')) return realFetch(input, init);
  const documentMatch =
    url.pathname === '/api/documents/import' ? null : /^\/api\/documents\/([^/]+)$/u.exec(url.pathname);
  if (documentMatch) {
    const id = documentMatch[1];
    const current = state.documents.get(id);
    if (!current) return Response.json({ ok: false, error: 'Document not found.' }, { status: 404 });
    if (method === 'PATCH') {
      const submitted = JSON.parse(String(init?.body));
      bodies.push({ url: url.pathname, body: submitted });
      if (scenario === 'conflict')
        return Response.json({ ok: false, error: 'Another editor saved changes.' }, { status: 409 });
      if (scenario === 'flush-fail' && id === 'sheet-a')
        return Response.json({ ok: false, error: 'Save unavailable.' }, { status: 503 });
      if (submitted.expectedRevision !== current.currentRevision)
        return Response.json(
          { ok: false, error: 'Revision conflict.', code: 'REVISION_CONFLICT' },
          { status: 409 },
        );
      if (current.model.version === 2 && submitted.model.version !== 2)
        return Response.json(
          { ok: false, error: 'Engine model required.', code: 'ENGINE_MODEL_REQUIRED' },
          { status: 409 },
        );
      const next = {
        ...current,
        title: submitted.title,
        model: submitted.model,
        currentRevision: current.currentRevision + 1,
        updatedAt: Date.now(),
      };
      state.documents.set(id, next);
      return Response.json({ ok: true, document: next });
    }
    return Response.json({ ok: true, document: current });
  }
  const suggestionMatch = /^\/api\/documents\/([^/]+)\/suggestions\/([^/]+)$/u.exec(url.pathname);
  if (suggestionMatch) {
    const submitted = JSON.parse(String(init?.body));
    bodies.push({ url: url.pathname, body: submitted });
    const current = state.documents.get(suggestionMatch[1]);
    if (submitted.decision === 'apply') {
      if (!submitted.model || submitted.model.version !== 2)
        return Response.json({ ok: false, error: 'Needs editor.', code: 'NEEDS_EDITOR' }, { status: 409 });
      await new Promise<void>((resolve) => {
        state.releaseSuggestion = resolve;
      });
      const next = {
        ...current,
        title: 'Add a contingency line',
        model: submitted.model,
        currentRevision: current.currentRevision + 1,
        suggestions: [],
      };
      state.documents.set(suggestionMatch[1], next);
      return Response.json({ ok: true, applied: true, document: next });
    }
    current.suggestions = current.suggestions.filter((s: any) => s.suggestionId !== suggestionMatch[2]);
    return Response.json({ ok: true, dismissed: true });
  }
  if (/^\/api\/documents\/[^/]+\/revisions$/u.test(url.pathname))
    return Response.json({ ok: true, revisions: [] });
  if (url.pathname === '/api/documents/import' && method === 'POST') {
    const form = init?.body as FormData;
    const file = form.get('file') as File;
    const model = JSON.parse(String(form.get('model')));
    const warnings = JSON.parse(String(form.get('warnings') || '[]'));
    const sha256 = await sha256Hex(await file.arrayBuffer());
    state.imported = { size: file.size, name: file.name, modelVersion: model.version, warnings, sha256 };
    const document = ownedDocument('imported', String(form.get('title')), model, {
      currentRevision: 1,
      importSource: {
        format: 'xlsx',
        filename: file.name,
        mimeType: file.type,
        size: file.size,
        sha256,
        storageId: 'storage',
        warnings,
        importedAt: Date.now(),
        revision: 1,
      },
    });
    state.documents.set('imported', document);
    return Response.json({ ok: true, document }, { status: 201 });
  }
  if (url.pathname === '/api/office') return Response.json({ ok: true, enabled: false, files: [] });
  if (url.pathname === '/api/files/status')
    return Response.json({ ok: true, connections: [], providers: [], icloud: { mode: 'device_folder' } });
  if (url.pathname === '/api/agent/uploads') return Response.json({ ok: true, files: [] });
  if (url.pathname === '/api/documents')
    return Response.json({ ok: true, documents: [...state.documents.values()] });
  if (url.pathname === '/api/files/library')
    return Response.json({
      ok: true,
      items:
        url.searchParams.get('kind') === 'uploads'
          ? []
          : [...state.documents.values()].map((document) => ({
              id: document.documentId,
              documentId: document.documentId,
              name: document.title,
              provider: 'albatross',
              mimeType: `application/x-albatross-${document.kind === 'sheet' ? 'spreadsheet' : 'document'}`,
              modifiedAt: document.updatedAt,
              isFolder: false,
            })),
      nextCursor: undefined,
    });
  return Response.json({ ok: false, error: 'Synthetic fixture: unexpected request' }, { status: 404 });
}) as typeof fetch;

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <SidebarProvider>
        <div className="flex h-dvh w-full min-w-0 flex-col text-[var(--color-text)]">
          <div className="min-h-0 flex-1">
            <FilesSurface />
          </div>
        </div>
        <Toaster position="bottom-right" />
      </SidebarProvider>
    </TooltipProvider>
  </QueryClientProvider>,
);

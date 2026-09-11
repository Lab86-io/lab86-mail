'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  CloudUpload,
  Download,
  ExternalLink,
  History,
  Loader2,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PresentationEditor } from '@/components/files/editors/PresentationEditor';
import { RichDocumentEditor } from '@/components/files/editors/RichDocumentEditor';
import { OdooSpreadsheetEditor } from '@/components/files/OdooSpreadsheetEditor';
import { useDocumentPanel, useNarrowDocumentWorkspace } from '@/components/files/useDocumentPanel';
import { useOutgoingEdits } from '@/components/files/useOutgoingEdits';
import { Button } from '@/components/ui/button';
import { useClientStore } from '@/lib/client-state';
import { documentDraftMatchesSave } from '@/lib/documents/autosave';
import { discardDraft, peekDraft, pendingFlush, type RetainedDraft } from '@/lib/documents/draft-store';
import { googleModelWriteLimitation } from '@/lib/documents/google-write-policy';
import type {
  AlbatrossDocumentModel,
  AlbatrossDocumentRecord,
  DocumentKind,
  DocumentSuggestion,
  SheetChangeSet,
  SheetGridModel,
} from '@/lib/documents/model';
import {
  applySheetChangeSet,
  downloadBlob,
  exportXlsxBlob,
  type SpreadsheetSession,
} from '@/lib/documents/odoo-spreadsheet-engine';
import { ODOO_SPREADSHEET_ASSET_BASE, ODOO_SPREADSHEET_VERSION } from '@/lib/documents/sheet-workbook';
import { cn } from '@/lib/utils';

interface EditorDocument extends AlbatrossDocumentRecord {
  suggestions: DocumentSuggestion[];
}

export interface GoogleEditorSource {
  connectionId: string;
  fileId: string;
  mimeType:
    | 'application/vnd.google-apps.document'
    | 'application/vnd.google-apps.spreadsheet'
    | 'application/vnd.google-apps.presentation';
  webUrl?: string;
}

interface GoogleEditorFile extends GoogleEditorSource {
  source: 'google_drive';
  kind: DocumentKind;
  title: string;
  model: AlbatrossDocumentModel;
  webUrl?: string;
  providerVersion?: string;
  editability?: { editable: boolean; reason?: string };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    const error = new Error(body?.error || `Request failed (${response.status})`) as Error & {
      status?: number;
      body?: any;
    };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body as T;
}

function kindName(kind: DocumentKind) {
  if (kind === 'sheet') return 'Spreadsheet';
  if (kind === 'deck') return 'Presentation';
  return 'Document';
}

function useAssistantDocument(
  context: import('@/lib/shell/assistant-context').AssistantDocumentContext | null,
) {
  const key = context ? `${context.provider}:${context.id}` : null;
  const serialized = JSON.stringify(context);
  useEffect(() => {
    useClientStore.getState().setAssistantDocument(JSON.parse(serialized));
  }, [serialized]);
  useEffect(
    () => () => {
      const state = useClientStore.getState();
      const active = state.assistantDocument;
      if (active && `${active.provider}:${active.id}` === key) state.setAssistantDocument(null);
    },
    [key],
  );
}

function openDocumentChat() {
  useClientStore.getState().setAssistantPresentation('split');
}

export function DocumentEditor({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { ref: workspaceRef, narrow, measured } = useNarrowDocumentWorkspace();
  const revisionRef = useRef(0);
  const revisionKeyRef = useRef('0');
  const loadedRevisionRef = useRef<number | null>(null);
  const saveQueuedRef = useRef(false);
  const titleRef = useRef('');
  const modelRef = useRef<AlbatrossDocumentModel | null>(null);
  const dirtyRef = useRef(false);
  const inflightRef = useRef<Promise<unknown> | null>(null);
  const lastSavedRef = useRef<{ title: string; model: AlbatrossDocumentModel } | null>(null);
  const saveBlockedRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [title, setTitle] = useState('');
  const [model, setModel] = useState<AlbatrossDocumentModel | null>(null);
  const [dirty, setDirty] = useState(false);
  const [engineKey, setEngineKey] = useState(0);
  const [session, setSession] = useState<SpreadsheetSession | null>(null);
  const [recovered, setRecovered] = useState<string | null>(null);
  const [staleDraft, setStaleDraft] = useState<RetainedDraft<AlbatrossDocumentModel> | null>(null);
  const [importNotesOpen, setImportNotesOpen] = useState(false);
  const draftKey = `document:${documentId}`;
  dirtyRef.current = dirty;
  useEffect(() => {
    if (measured && narrow) setHistoryOpen(false);
  }, [measured, narrow]);

  const documentQuery = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => fetchJson<{ ok: true; document: EditorDocument }>(`/api/documents/${documentId}`),
    staleTime: 10_000,
  });
  const document = documentQuery.data?.document;
  useAssistantDocument(
    document
      ? {
          id: documentId,
          provider: 'albatross',
          title: title || document.title,
          kind: document.kind,
          revision: document.currentRevision,
          dirty,
        }
      : null,
  );

  const adoptServerDocument = useCallback((latest: EditorDocument) => {
    setTitle(latest.title);
    setModel(latest.model);
    titleRef.current = latest.title;
    modelRef.current = latest.model;
    revisionRef.current = latest.currentRevision;
    revisionKeyRef.current = String(latest.currentRevision);
    lastSavedRef.current = { title: latest.title, model: latest.model };
    if (loadedRevisionRef.current !== latest.currentRevision) {
      loadedRevisionRef.current = latest.currentRevision;
      setEngineKey((value) => value + 1);
    }
  }, []);

  useEffect(() => {
    if (!document || dirty) return;
    const draft = peekDraft<AlbatrossDocumentModel>(draftKey);
    if (draft) {
      const flush = pendingFlush(draftKey);
      if (flush) {
        // An earlier instance is still saving this file; wait for that outcome
        // rather than loading a version it is about to change.
        let cancelled = false;
        void flush.then(() => {
          if (!cancelled) void documentQuery.refetch();
        });
        return () => {
          cancelled = true;
        };
      }
      discardDraft(draftKey);
      if (draft.base === String(document.currentRevision)) {
        // Same base revision: resume exactly where the previous instance left off.
        adoptServerDocument(document);
        setTitle(draft.title);
        setModel(draft.model);
        titleRef.current = draft.title;
        modelRef.current = draft.model;
        loadedRevisionRef.current = document.currentRevision;
        setEngineKey((value) => value + 1);
        setDirty(true);
        setRecovered(
          draft.lastError
            ? `Your unsaved edits from a moment ago were kept (${draft.lastError}). Saving resumes now.`
            : 'Your unsaved edits from a moment ago were kept.',
        );
        return;
      }
      setStaleDraft(draft);
    }
    adoptServerDocument(document);
  }, [adoptServerDocument, dirty, document, documentQuery.refetch, draftKey]);

  const saveMutation = useMutation({
    mutationFn: async (input: { title: string; model: AlbatrossDocumentModel }) =>
      fetchJson<{ ok: true; document: EditorDocument }>(`/api/documents/${documentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: revisionRef.current,
          title: input.title,
          model: input.model,
          reason: 'inline_edit',
        }),
      }),
    onSuccess: (result, saved) => {
      if (result.document.documentId !== documentId) return; // never let another file's reply land here
      saveBlockedRef.current = false;
      setSaveError(null);
      revisionRef.current = result.document.currentRevision;
      revisionKeyRef.current = String(result.document.currentRevision);
      loadedRevisionRef.current = result.document.currentRevision;
      lastSavedRef.current = saved;
      const latestMatchesSaved = documentDraftMatchesSave(
        { title: titleRef.current, model: modelRef.current },
        saved,
      );
      setDirty(!latestMatchesSaved);
      setRecovered(null);
      queryClient.setQueryData(['document', documentId], {
        ok: true,
        document: { ...document, ...result.document, suggestions: document?.suggestions || [] },
      });
    },
    onError: (error: Error & { status?: number }) => {
      saveBlockedRef.current = true;
      saveQueuedRef.current = false;
      setSaveError(
        error.status === 409
          ? 'This file changed elsewhere. Your edits are still here. Download your draft before loading the saved version.'
          : error.status === 413
            ? `${error.message} Your edits are still here.`
            : `${error.message} Your edits are still here. Retry when you are ready.`,
      );
    },
    onSettled: () => {
      if (saveQueuedRef.current && !saveBlockedRef.current) {
        saveQueuedRef.current = false;
        if (modelRef.current) {
          inflightRef.current = saveMutation
            .mutateAsync({ title: titleRef.current, model: modelRef.current })
            .catch(() => undefined);
        }
      }
    },
  });

  const saveNow = useCallback(async () => {
    if (saveBlockedRef.current) return false;
    if (!dirty || !model) return true;
    if (saveMutation.isPending) {
      saveQueuedRef.current = true;
      return false;
    }
    const submitted = { title, model };
    try {
      const request = saveMutation.mutateAsync(submitted);
      inflightRef.current = request.catch(() => undefined);
      await request;
      return documentDraftMatchesSave({ title: titleRef.current, model: modelRef.current }, submitted);
    } catch {
      return false;
    }
  }, [dirty, model, saveMutation, title]);

  useOutgoingEdits<AlbatrossDocumentModel>({
    draftKey,
    dirtyRef,
    titleRef,
    modelRef,
    baseRef: revisionKeyRef,
    inflightRef,
    save: async (draft) => {
      if (lastSavedRef.current && documentDraftMatchesSave(lastSavedRef.current, draft)) return { ok: true };
      try {
        const result = await fetchJson<{ ok: true; document: EditorDocument }>(
          `/api/documents/${documentId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            keepalive: true,
            body: JSON.stringify({
              expectedRevision: Number(draft.base),
              title: draft.title,
              model: draft.model,
              reason: 'inline_edit',
            }),
          },
        );
        queryClient.setQueryData(
          ['document', documentId],
          (current: { document?: EditorDocument } | undefined) => ({
            ok: true,
            document: {
              ...current?.document,
              ...result.document,
              suggestions: current?.document?.suggestions || [],
            },
          }),
        );
        return { ok: true };
      } catch (error) {
        const status = (error as { status?: number }).status;
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Save failed.',
          conflict: status === 409,
        };
      }
    },
  });

  useEffect(() => {
    if (!dirty || !model || saveError) return;
    const timer = window.setTimeout(() => void saveNow(), 900);
    return () => window.clearTimeout(timer);
  }, [dirty, model, saveNow, saveError]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const editModel = useCallback((next: AlbatrossDocumentModel) => {
    modelRef.current = next;
    setModel(next);
    setDirty(true);
  }, []);

  const loadSavedVersion = useCallback(async () => {
    const result = await documentQuery.refetch();
    if (result.error || !result.data?.document) return false;
    loadedRevisionRef.current = null; // force the engine to rebuild from the saved snapshot
    adoptServerDocument(result.data.document);
    setDirty(false);
    setSaveError(null);
    setRecovered(null);
    saveBlockedRef.current = false;
    return true;
  }, [adoptServerDocument, documentQuery]);

  const downloadRecoveredDraft = useCallback(
    (draft: { title: string; model: AlbatrossDocumentModel; base: string }) => {
      const blob = new Blob(
        [
          JSON.stringify(
            { title: draft.title, model: draft.model, expectedRevision: Number(draft.base) },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      );
      downloadBlob(blob, 'albatross-recovered-draft.json');
    },
    [],
  );

  const exportMutation = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error('Open the spreadsheet before downloading it.');
      return exportXlsxBlob(session.model);
    },
    onSuccess: (blob) =>
      downloadBlob(blob, `${(title.trim() || 'Untitled').replace(/[\\/:*?"<>|]+/gu, '_')}.xlsx`),
    onError: (error: Error) => toast.error(error.message),
  });

  const fileExportMutation = useMutation({
    mutationFn: async () => {
      if (!(await saveNow())) throw new Error('Save or recover your changes before downloading this file.');
      const response = await fetch(`/api/documents/${documentId}/export`, { cache: 'no-store' });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || 'The file could not be downloaded.');
      }
      return {
        blob: await response.blob(),
        filename: `${(title.trim() || 'Untitled').replace(/[\\/:*?"<>|]+/gu, '_')}.${model?.kind === 'deck' ? 'pptx' : 'docx'}`,
      };
    },
    onSuccess: ({ blob, filename }) => downloadBlob(blob, filename),
    onError: (error: Error) => toast.error(error.message),
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      if (!(await saveNow())) throw new Error('Save this file before publishing it.');
      return fetchJson<{ ok: true; google: { webUrl?: string } }>(`/api/documents/${documentId}/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    },
    onSuccess: async ({ google }) => {
      await Promise.all([
        documentQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ['cloud-files'] }),
      ]);
      toast.success(document?.google ? 'Google file updated' : 'Published to Google Drive', {
        action: google.webUrl
          ? {
              label: 'Open in Google',
              onClick: () => window.open(google.webUrl, '_blank', 'noopener,noreferrer'),
            }
          : undefined,
      });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const pullGoogleMutation = useMutation({
    mutationFn: async () => {
      if (!document?.google) throw new Error('This file is not linked to Google.');
      if (!(await saveNow())) throw new Error('Save or recover your edits before importing a newer version.');
      return fetchJson<{ ok: true; document: EditorDocument }>('/api/files/google/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId: document.google.connectionId,
          fileId: document.google.fileId,
          mimeType: document.google.mimeType,
          webUrl: document.google.webUrl,
          mode: 'refresh',
        }),
      });
    },
    onSuccess: async () => {
      toast.success('Imported the latest Google version');
      setDirty(false);
      await documentQuery.refetch();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (!document && !documentQuery.isLoading) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <p className="text-[14px] font-medium">This file could not be opened.</p>
          <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
            {(documentQuery.error as Error)?.message || 'The file may have been removed.'}
          </p>
          <Button className="mt-4" variant="outline" size="sm" onClick={onClose}>
            Back to Files
          </Button>
        </div>
      </div>
    );
  }
  if (documentQuery.isLoading || !model) {
    return (
      <div className="grid h-full place-items-center text-[12.5px] text-[var(--color-text-muted)]">
        <div className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" />
          Opening file…
        </div>
      </div>
    );
  }
  if (!document) {
    return null;
  }

  const googleBehind =
    Boolean(document.google) && (document.google?.syncedRevision || 0) < revisionRef.current;
  const engineSheet = model.kind === 'sheet';
  const googleWriteNotice =
    googleModelWriteLimitation(model) ||
    (engineSheet
      ? 'This sheet opens in Odoo. Download Spreadsheet to preserve its workbook features; Google sync is unavailable here.'
      : undefined);
  const googleWriteBlocked = engineSheet || Boolean(googleWriteNotice);
  const importNotes = document.importSource?.warnings || [];

  return (
    <section
      ref={workspaceRef}
      data-document-workspace
      aria-label={`${kindName(document.kind)} editor`}
      className="@container/document flex h-full min-h-0 min-w-0 flex-col"
    >
      <header className="flex min-h-14 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to Files"
          disabled={applying}
          onClick={() => void saveNow().then((saved) => saved && onClose())}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <input
            aria-label="File name"
            disabled={applying}
            value={title}
            onChange={(event) => {
              titleRef.current = event.target.value;
              setTitle(event.target.value);
              setDirty(true);
            }}
            className="block h-6 w-full truncate bg-transparent text-[13.5px] font-medium outline-none"
          />
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-1.5 text-[10.5px] text-[var(--color-text-faint)]"
          >
            {applying ? (
              'Applying revision…'
            ) : saveMutation.isPending ? (
              <>
                <Loader2 className="size-2.5 animate-spin" /> Saving
              </>
            ) : saveError ? (
              'Save needs attention · draft retained'
            ) : recovered ? (
              'Recovered unsaved edits'
            ) : dirty ? (
              'Unsaved changes'
            ) : (
              <>
                <Check className="size-2.5" /> Saved · revision {revisionRef.current}
              </>
            )}
            {googleBehind ? <span>· Google version behind</span> : null}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => publishMutation.mutate()}
          disabled={googleWriteBlocked || publishMutation.isPending || saveMutation.isPending || dirty}
          aria-label={document.google ? 'Sync Google' : 'Publish to Google'}
          title={googleWriteBlocked ? googleWriteNotice : undefined}
        >
          {publishMutation.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <CloudUpload className="size-3.5" />
          )}
          <span className="hidden sm:inline">{document.google ? 'Sync Google' : 'Publish'}</span>
        </Button>
        {document.google ? (
          <Button
            variant="outline"
            size="icon-sm"
            title="Import latest Google changes"
            aria-label="Import latest Google changes"
            onClick={() => pullGoogleMutation.mutate()}
            disabled={googleWriteBlocked || pullGoogleMutation.isPending || saveMutation.isPending || dirty}
          >
            <RefreshCw className={cn('size-3.5', pullGoogleMutation.isPending && 'animate-spin')} />
          </Button>
        ) : null}
        {engineSheet ? (
          <Button
            variant="outline"
            size="icon-sm"
            title="Download Spreadsheet"
            aria-label="Download Spreadsheet"
            disabled={!session || exportMutation.isPending}
            onClick={() => exportMutation.mutate()}
          >
            {exportMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="icon-sm"
            title={`Save and download ${kindName(document.kind).toLowerCase()}`}
            aria-label={`Download ${kindName(document.kind)}`}
            disabled={applying || saveMutation.isPending || fileExportMutation.isPending}
            onClick={() => fileExportMutation.mutate()}
          >
            {fileExportMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={openDocumentChat} aria-label="Edit with Albatross">
          <span>Albatross</span>
        </Button>
      </header>

      {googleWriteBlocked ? (
        <p className="border-b border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-text-muted)]">
          {googleWriteNotice}
        </p>
      ) : null}
      {saveError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 text-xs"
        >
          <p className="min-w-0 flex-1 basis-56">{saveError}</p>
          <Button
            variant="outline"
            size="xs"
            onClick={() => downloadRecoveredDraft({ title, model, base: String(revisionRef.current) })}
          >
            Download my draft
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              saveBlockedRef.current = false;
              setSaveError(null);
              void saveNow();
            }}
          >
            Retry save
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={async () => {
              if (
                !window.confirm(
                  'Replace your unsaved edits with the saved version? Download your draft first if you want to keep it.',
                )
              )
                return;
              await loadSavedVersion();
            }}
          >
            Load saved version
          </Button>
        </div>
      ) : null}
      {recovered && !saveError ? (
        <p
          role="status"
          className="border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-2 text-xs"
        >
          {recovered}
        </p>
      ) : null}
      {staleDraft ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 text-xs"
        >
          <p className="min-w-0 flex-1 basis-56">
            Unsaved edits from an earlier visit could not be saved because this file changed (revision{' '}
            {staleDraft.base} to {document.currentRevision}). They were not applied. Download them or discard
            them.
          </p>
          <Button variant="outline" size="xs" onClick={() => downloadRecoveredDraft(staleDraft)}>
            Download earlier edits
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setStaleDraft(null)}>
            Discard
          </Button>
        </div>
      ) : null}

      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-4 text-[11px] text-[var(--color-text-muted)]">
        <span>Albatross / {kindName(document.kind)}</span>
        <span className="hidden sm:inline">Private working copy</span>
        {engineSheet ? (
          <a
            className="hidden underline-offset-2 hover:underline md:inline"
            href={`${ODOO_SPREADSHEET_ASSET_BASE}/LICENSE`}
            target="_blank"
            rel="noreferrer"
            title="Spreadsheet engine license"
          >
            Engine: o-spreadsheet {ODOO_SPREADSHEET_VERSION} (LGPL-3.0)
          </a>
        ) : null}
        {document.importSource ? (
          <span className="hidden min-w-0 items-center gap-2 truncate lg:flex">
            <span className="truncate">Imported from {document.importSource.filename}</span>
            <a
              className="shrink-0 underline-offset-2 hover:underline"
              href={`/api/documents/${documentId}/original`}
            >
              Download original
            </a>
            {importNotes.length ? (
              <button
                type="button"
                className="shrink-0 underline-offset-2 hover:underline"
                aria-expanded={importNotesOpen}
                onClick={() => setImportNotesOpen((value) => !value)}
              >
                {importNotes.length} import {importNotes.length === 1 ? 'note' : 'notes'}
              </button>
            ) : null}
          </span>
        ) : null}
        <Button
          className="ml-auto"
          variant="ghost"
          size="xs"
          aria-pressed={historyOpen}
          onClick={() => {
            setHistoryOpen((value) => !value);
          }}
        >
          <History className="size-3.5" /> Versions
        </Button>
      </div>
      {importNotesOpen && importNotes.length ? (
        <section
          aria-label="Import notes"
          className="max-h-40 overflow-auto border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-2 text-[11px] text-[var(--color-text-muted)]"
        >
          <p className="mb-1 text-[var(--color-text)]">
            The engine reported these when reading the original. Compare with the original before relying on
            affected cells.
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {importNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <div
        className={cn(
          'grid min-h-0 flex-1',
          historyOpen
            ? 'relative grid-cols-1 @[900px]/document:grid-cols-[minmax(0,1fr)_320px]'
            : 'grid-cols-1',
        )}
      >
        <fieldset
          disabled={applying}
          inert={applying || (narrow && historyOpen)}
          aria-hidden={narrow && historyOpen ? true : undefined}
          className="min-h-0 min-w-0 overflow-hidden bg-[var(--color-content)]"
        >
          {model.kind === 'doc' ? (
            <RichDocumentEditor model={model} onChange={editModel} readOnly={applying} />
          ) : null}
          {model.kind === 'sheet' ? (
            <OdooSpreadsheetEditor
              model={model}
              sessionKey={`${documentId}:${engineKey}`}
              readOnly={applying}
              onChange={editModel}
              onSession={setSession}
            />
          ) : null}
          {model.kind === 'deck' ? (
            <PresentationEditor model={model} onChange={editModel} readOnly={applying} />
          ) : null}
        </fieldset>
        {historyOpen ? (
          <DocumentHistory
            documentId={documentId}
            currentRevision={revisionRef.current}
            blocked={dirty || saveMutation.isPending}
            onRestoring={setApplying}
            onClose={() => setHistoryOpen(false)}
            onRestored={async () => {
              await documentQuery.refetch();
            }}
          />
        ) : null}
      </div>
      <DocumentSuggestionReview
        documentId={documentId}
        document={document}
        session={session}
        blocked={dirty || saveMutation.isPending}
        onApplying={setApplying}
        onChanged={async (revision, options) => {
          setDirty(false);
          if (revision !== undefined) {
            revisionRef.current = revision;
            revisionKeyRef.current = String(revision);
            // The live engine already holds this revision's state; don't rebuild it.
            if (options?.engineCurrent) loadedRevisionRef.current = revision;
          }
          await documentQuery.refetch();
        }}
      />
    </section>
  );
}

export function GoogleDocumentEditor({
  source,
  onClose,
}: {
  source: GoogleEditorSource;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { ref: workspaceRef } = useNarrowDocumentWorkspace();
  const saveQueuedRef = useRef(false);
  const titleRef = useRef('');
  const modelRef = useRef<AlbatrossDocumentModel | null>(null);
  const versionRef = useRef<string | undefined>(undefined);
  const versionKeyRef = useRef('');
  const dirtyRef = useRef(false);
  const inflightRef = useRef<Promise<unknown> | null>(null);
  const lastSavedRef = useRef<{ title: string; model: AlbatrossDocumentModel } | null>(null);
  const saveBlockedRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [model, setModel] = useState<AlbatrossDocumentModel | null>(null);
  const [dirty, setDirty] = useState(false);
  const [recovered, setRecovered] = useState<string | null>(null);
  const [staleDraft, setStaleDraft] = useState<RetainedDraft<AlbatrossDocumentModel> | null>(null);
  const draftKey = `google:${source.connectionId}:${source.fileId}:${source.mimeType}`;
  dirtyRef.current = dirty;

  const queryKey = ['google-document', source.connectionId, source.fileId] as const;
  const fileQuery = useQuery({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams({
        connectionId: source.connectionId,
        fileId: source.fileId,
        mimeType: source.mimeType,
      });
      return fetchJson<{ ok: true; file: GoogleEditorFile }>(`/api/files/google/editor?${params}`);
    },
    staleTime: 10_000,
  });
  const suggestionKey = ['google-document-suggestions', source.connectionId, source.fileId];
  const suggestions = useQuery<GoogleEditorSuggestion[]>({
    queryKey: suggestionKey,
    initialData: [],
    enabled: false,
  });
  const dismissSuggestion = (id: string) =>
    queryClient.setQueryData(suggestionKey, (items: GoogleEditorSuggestion[] = []) =>
      items.filter((item) => item.suggestionId !== id),
    );
  const file = fileQuery.data?.file;
  useAssistantDocument(
    file
      ? {
          id: source.fileId,
          provider: 'google',
          connectionId: source.connectionId,
          mimeType: source.mimeType,
          title: title || file.title,
          kind: file.kind,
          dirty,
        }
      : null,
  );

  useEffect(() => {
    if (!file || dirty) return;
    const draft = peekDraft<AlbatrossDocumentModel>(draftKey);
    if (draft) {
      const flush = pendingFlush(draftKey);
      if (flush) {
        let cancelled = false;
        void flush.then(() => {
          if (!cancelled) void fileQuery.refetch();
        });
        return () => {
          cancelled = true;
        };
      }
      discardDraft(draftKey);
      if (draft.base === String(file.providerVersion ?? '')) {
        setTitle(draft.title);
        setModel(draft.model);
        titleRef.current = draft.title;
        modelRef.current = draft.model;
        versionRef.current = file.providerVersion;
        versionKeyRef.current = String(file.providerVersion ?? '');
        lastSavedRef.current = { title: file.title, model: file.model };
        setDirty(true);
        setRecovered('Your unsaved edits from a moment ago were kept.');
        return;
      }
      setStaleDraft(draft);
    }
    setTitle(file.title);
    setModel(file.model);
    titleRef.current = file.title;
    modelRef.current = file.model;
    versionRef.current = file.providerVersion;
    versionKeyRef.current = String(file.providerVersion ?? '');
    lastSavedRef.current = { title: file.title, model: file.model };
  }, [dirty, draftKey, file, fileQuery.refetch]);

  const saveMutation = useMutation({
    mutationFn: (input: { title: string; model: AlbatrossDocumentModel }) =>
      fetchJson<{ ok: true; file: GoogleEditorFile }>('/api/files/google/editor', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...source,
          title: input.title,
          model: input.model,
          expectedProviderVersion: versionRef.current,
        }),
      }),
    onSuccess: ({ file: saved }, submitted) => {
      if (saved.fileId && saved.fileId !== source.fileId) return;
      versionRef.current = saved.providerVersion;
      versionKeyRef.current = String(saved.providerVersion ?? '');
      lastSavedRef.current = submitted;
      const latestMatchesSaved = documentDraftMatchesSave(
        { title: titleRef.current, model: modelRef.current },
        submitted,
      );
      setDirty(!latestMatchesSaved);
      setRecovered(null);
      queryClient.setQueryData(queryKey, { ok: true, file: { ...saved, editability: file?.editability } });
      void queryClient.invalidateQueries({ queryKey: ['cloud-files'] });
    },
    onError: async (error: Error & { status?: number }) => {
      saveBlockedRef.current = true;
      saveQueuedRef.current = false;
      setSaveError(
        error.status === 409
          ? 'The original changed in Google. Your local draft is preserved; automatic saving has stopped.'
          : error.message,
      );
      if (error.status === 409) {
        toast.error('This file changed in Google Drive. Your unsaved edit was not overwritten.');
      } else {
        toast.error(error.message);
      }
    },
    onSettled: () => {
      if (!saveBlockedRef.current && saveQueuedRef.current && modelRef.current) {
        saveQueuedRef.current = false;
        inflightRef.current = saveMutation
          .mutateAsync({ title: titleRef.current, model: modelRef.current })
          .catch(() => undefined);
      }
    },
  });

  const saveNow = useCallback(async () => {
    if (saveBlockedRef.current) return false;
    if (!dirty || !model) return true;
    if (saveMutation.isPending) {
      saveQueuedRef.current = true;
      return false;
    }
    const submitted = { title, model };
    try {
      const request = saveMutation.mutateAsync(submitted);
      inflightRef.current = request.catch(() => undefined);
      await request;
      return documentDraftMatchesSave({ title: titleRef.current, model: modelRef.current }, submitted);
    } catch {
      return false;
    }
  }, [dirty, model, saveMutation, title]);

  useOutgoingEdits<AlbatrossDocumentModel>({
    draftKey,
    dirtyRef,
    titleRef,
    modelRef,
    baseRef: versionKeyRef,
    inflightRef,
    save: async (draft) => {
      if (lastSavedRef.current && documentDraftMatchesSave(lastSavedRef.current, draft)) return { ok: true };
      try {
        await fetchJson<{ ok: true; file: GoogleEditorFile }>('/api/files/google/editor', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify({
            ...source,
            title: draft.title,
            model: draft.model,
            expectedProviderVersion: draft.base || undefined,
          }),
        });
        void queryClient.invalidateQueries({ queryKey });
        return { ok: true };
      } catch (error) {
        const status = (error as { status?: number }).status;
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Save failed.',
          conflict: status === 409,
        };
      }
    },
  });

  useEffect(() => {
    if (!dirty || !model || saveError) return;
    const timer = window.setTimeout(() => void saveNow(), 900);
    return () => window.clearTimeout(timer);
  }, [dirty, model, saveNow, saveError]);

  const editModel = useCallback((next: AlbatrossDocumentModel) => {
    modelRef.current = next;
    setModel(next);
    setDirty(true);
  }, []);

  if (!file && !fileQuery.isLoading) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <p className="text-[14px] font-medium">This Google file could not be opened.</p>
          <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
            {(fileQuery.error as Error)?.message || 'The file may no longer be shared with you.'}
          </p>
          <Button className="mt-4" variant="outline" size="sm" onClick={onClose}>
            Back to Files
          </Button>
        </div>
      </div>
    );
  }
  if (fileQuery.isLoading || !file || !model) {
    return (
      <div className="grid h-full place-items-center text-[12.5px] text-[var(--color-text-muted)]">
        <div className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" />
          Opening from Google Drive…
        </div>
      </div>
    );
  }

  if (file.editability?.editable !== true && !dirty) {
    return (
      <section aria-label="Google file preview" className="flex h-full min-h-0 min-w-0 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] p-3">
          <Button variant="ghost" onClick={onClose}>
            Back to Files
          </Button>
          <h1 className="min-w-0 flex-1 break-words font-medium">{file.title}</h1>
          <Button asChild variant="outline">
            <a
              href={file.webUrl || `https://drive.google.com/open?id=${encodeURIComponent(source.fileId)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open original in Google
            </a>
          </Button>
        </header>
        <div className="overflow-y-auto p-4 sm:p-6">
          <p
            role="status"
            className="mb-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3 text-sm"
          >
            {file.editability?.reason ||
              'Preview only. Open the original in Google to preserve its full content and formatting.'}{' '}
            No changes have been saved.
          </p>
          {model.kind === 'doc' ? (
            <div className="mx-auto max-w-2xl whitespace-pre-wrap break-words text-sm leading-relaxed">
              <p className="mb-3 text-xs text-[var(--color-text-muted)]">
                Text excerpt · tables, images and formatting may not appear here
              </p>
              {model.blocks.map((block) => (
                <p key={block.id} className="mb-3">
                  {block.text || '\u00a0'}
                </p>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[var(--color-text-muted)]">
              Use Google for the complete spreadsheet or presentation. Your original remains unchanged.
            </p>
          )}
        </div>
      </section>
    );
  }
  return (
    <section
      ref={workspaceRef}
      data-document-workspace
      aria-label={`${kindName(file.kind)} editor`}
      className="@container/document flex h-full min-h-0 min-w-0 flex-col"
    >
      {saveError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3 text-sm"
        >
          <p className="min-w-0 flex-1">
            {saveError} Copy any local edits you want to keep before reloading.
          </p>
          <Button
            variant="outline"
            onClick={async () => {
              if (!window.confirm('Discard this local draft and reload the original from Google?')) return;
              const refreshed = await fileQuery.refetch();
              if (!refreshed.isSuccess || !refreshed.data?.file) return;
              const next = refreshed.data.file;
              titleRef.current = next.title;
              modelRef.current = next.model;
              versionRef.current = next.providerVersion;
              versionKeyRef.current = String(next.providerVersion ?? '');
              lastSavedRef.current = { title: next.title, model: next.model };
              setTitle(next.title);
              setModel(next.model);
              setDirty(false);
              setSaveError(null);
              setRecovered(null);
              saveBlockedRef.current = false;
            }}
          >
            Reload original
          </Button>
        </div>
      ) : null}
      {recovered && !saveError ? (
        <p
          role="status"
          className="border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2 text-xs"
        >
          {recovered}
        </p>
      ) : null}
      {staleDraft ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3 text-sm"
        >
          <p className="min-w-0 flex-1">
            Unsaved edits from an earlier visit were not saved because the Google file changed. They were not
            applied.
          </p>
          <Button
            variant="outline"
            onClick={() =>
              downloadBlob(
                new Blob([JSON.stringify({ title: staleDraft.title, model: staleDraft.model }, null, 2)], {
                  type: 'application/json',
                }),
                'albatross-recovered-draft.json',
              )
            }
          >
            Download earlier edits
          </Button>
          <Button variant="ghost" onClick={() => setStaleDraft(null)}>
            Discard
          </Button>
        </div>
      ) : null}
      <header className="flex min-h-14 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to Files"
          onClick={() => void saveNow().then((saved) => saved && onClose())}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <input
            aria-label="File name"
            value={title}
            onChange={(event) => {
              titleRef.current = event.target.value;
              setTitle(event.target.value);
              setDirty(true);
            }}
            className="block h-6 w-full truncate bg-transparent text-[13.5px] font-medium outline-none"
          />
          <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--color-text-faint)]">
            {saveMutation.isPending ? (
              <>
                <Loader2 className="size-2.5 animate-spin" /> Saving to Google Drive
              </>
            ) : dirty ? (
              'Unsaved changes'
            ) : (
              <>
                <Check className="size-2.5" /> Saved to Google Drive
              </>
            )}
          </div>
        </div>
        {file.webUrl || source.webUrl ? (
          <Button asChild variant="outline" size="sm">
            <a href={file.webUrl || source.webUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3.5" />
              <span className="hidden sm:inline">Open in Google</span>
            </a>
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={openDocumentChat} aria-label="Edit with Albatross">
          <span>Albatross</span>
        </Button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1">
        <div className="min-h-0 overflow-hidden bg-[var(--color-content)]">
          {model.kind === 'doc' ? (
            <RichDocumentEditor model={model} onChange={editModel} plainTextOnly />
          ) : null}
          {model.kind === 'sheet' && model.version === 1 ? (
            <SheetEditor model={model} onChange={editModel} />
          ) : null}
          {model.kind === 'sheet' && model.version === 2 ? (
            <p className="p-4 text-sm text-[var(--color-text-muted)]">
              This Google sheet is stored as an engine workbook, which the Google editor cannot round-trip.
            </p>
          ) : null}
          {model.kind === 'deck' ? <PresentationEditor model={model} onChange={editModel} /> : null}
        </div>
      </div>
      {suggestions.data?.length ? (
        <section
          aria-label="Suggested document edits"
          className="max-h-[40%] shrink-0 overflow-auto border-t border-[var(--color-border)] bg-[var(--color-content)] p-3"
        >
          <h2 className="text-xs font-medium">Suggested edits</h2>
          {suggestions.data.map((suggestion) => (
            <div
              key={suggestion.suggestionId}
              className="mt-2 rounded-ui border border-[var(--color-border)] p-3 text-xs"
            >
              <p>{suggestion.summary}</p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="xs"
                  disabled={
                    dirty ||
                    Boolean(saveError) ||
                    saveMutation.isPending ||
                    suggestion.expectedProviderVersion !== versionKeyRef.current
                  }
                  onClick={() => {
                    if (
                      dirtyRef.current ||
                      saveBlockedRef.current ||
                      saveMutation.isPending ||
                      suggestion.expectedProviderVersion !== versionKeyRef.current
                    ) {
                      toast.error(
                        'This file changed. Save or recover your edits and ask for a fresh proposal.',
                      );
                      return;
                    }
                    const limitation = googleModelWriteLimitation(suggestion.model);
                    if (limitation) {
                      toast.error(limitation);
                      return;
                    }
                    titleRef.current = suggestion.title;
                    setTitle(suggestion.title);
                    editModel(suggestion.model);
                    dismissSuggestion(suggestion.suggestionId);
                  }}
                >
                  Apply
                </Button>
                <Button variant="ghost" size="xs" onClick={() => dismissSuggestion(suggestion.suggestionId)}>
                  Dismiss
                </Button>
              </div>
              {suggestion.expectedProviderVersion !== versionKeyRef.current ? (
                <p role="status" className="mt-2">
                  This file changed. Ask for a fresh proposal.
                </p>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
    </section>
  );
}

function SheetEditor({
  model,
  onChange,
}: {
  model: SheetGridModel;
  onChange: (model: AlbatrossDocumentModel) => void;
}) {
  const active = model.sheets.find((sheet) => sheet.id === model.activeSheetId) || model.sheets[0];
  const [selected, setSelected] = useState('A1');
  const columns = useMemo(
    () => Array.from({ length: Math.min(active.columnCount, 26) }, (_, index) => columnName(index + 1)),
    [active.columnCount],
  );
  const rows = useMemo(
    () => Array.from({ length: Math.min(active.rowCount, 100) }, (_, index) => index + 1),
    [active.rowCount],
  );
  const selectedCell = active.cells[selected];

  const setCell = (address: string, raw: string) => {
    const cells = { ...active.cells };
    if (!raw) delete cells[address];
    else if (raw.startsWith('='))
      cells[address] = { ...(cells[address] || {}), formula: raw.slice(1), value: undefined };
    else {
      const numeric = Number(raw);
      cells[address] = {
        ...(cells[address] || {}),
        value: raw.trim() !== '' && Number.isFinite(numeric) ? numeric : raw,
        formula: undefined,
      };
    }
    onChange({
      ...model,
      sheets: model.sheets.map((sheet) => (sheet.id === active.id ? { ...sheet, cells } : sheet)),
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-white text-slate-900">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-slate-200 px-2">
        <span className="w-14 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-center text-xs font-medium">
          {selected}
        </span>
        <span className="text-xs font-semibold text-slate-500">fx</span>
        <input
          aria-label={`Formula or value for ${selected}`}
          value={selectedCell?.formula ? `=${selectedCell.formula}` : String(selectedCell?.value ?? '')}
          onChange={(event) => setCell(selected, event.target.value)}
          className="h-7 min-w-0 flex-1 border-l border-slate-200 px-2 text-sm outline-none"
          placeholder="Enter a value or formula"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div
          className="grid min-w-max"
          style={{ gridTemplateColumns: `44px repeat(${columns.length}, 112px)` }}
        >
          <div className="sticky left-0 top-0 z-30 h-8 border-b border-r border-slate-200 bg-slate-100" />
          {columns.map((column) => (
            <div
              key={column}
              className="sticky top-0 z-20 grid h-8 place-items-center border-b border-r border-slate-200 bg-slate-100 text-xs font-medium text-slate-500"
            >
              {column}
            </div>
          ))}
          {rows.flatMap((row) => [
            <div
              key={`row-${row}`}
              className="sticky left-0 z-10 grid h-8 place-items-center border-b border-r border-slate-200 bg-slate-100 text-xs text-slate-500"
            >
              {row}
            </div>,
            ...columns.map((column) => {
              const address = `${column}${row}`;
              const cell = active.cells[address];
              return (
                <input
                  key={address}
                  aria-label={`Cell ${address}`}
                  value={cell?.formula ? `=${cell.formula}` : String(cell?.value ?? '')}
                  onFocus={() => setSelected(address)}
                  onChange={(event) => setCell(address, event.target.value)}
                  className={cn(
                    'h-8 border-b border-r border-slate-200 px-1.5 text-xs outline-none',
                    selected === address && 'relative z-[1] ring-2 ring-inset ring-blue-500',
                  )}
                />
              );
            }),
          ])}
        </div>
      </div>
      <div className="flex h-10 shrink-0 items-center gap-1 border-t border-slate-200 bg-slate-50 px-2">
        {model.sheets.map((sheet) => (
          <button
            key={sheet.id}
            type="button"
            onClick={() => onChange({ ...model, activeSheetId: sheet.id })}
            className={cn(
              'h-8 rounded px-3 text-xs',
              sheet.id === active.id ? 'bg-white font-medium shadow-sm' : 'text-slate-500 hover:bg-white/70',
            )}
          >
            {sheet.name}
          </button>
        ))}
        <button
          type="button"
          aria-label="Add sheet"
          onClick={() => {
            const id = crypto.randomUUID();
            onChange({
              ...model,
              activeSheetId: id,
              sheets: [
                ...model.sheets,
                { id, name: `Sheet ${model.sheets.length + 1}`, rowCount: 100, columnCount: 26, cells: {} },
              ],
            });
          }}
          className="grid size-8 place-items-center rounded text-slate-500 hover:bg-white"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function columnName(index: number) {
  let value = index;
  let out = '';
  while (value > 0) {
    value -= 1;
    out = String.fromCharCode(65 + (value % 26)) + out;
    value = Math.floor(value / 26);
  }
  return out;
}

function DocumentHistory({
  documentId,
  currentRevision,
  blocked,
  onRestoring,
  onClose,
  onRestored,
}: {
  documentId: string;
  currentRevision: number;
  blocked: boolean;
  onRestoring: (value: boolean) => void;
  onClose: () => void;
  onRestored: () => Promise<void>;
}) {
  const panel = useDocumentPanel(onClose);
  const history = useQuery({
    queryKey: ['document-history', documentId, currentRevision],
    queryFn: () =>
      fetchJson<{
        revisions: Array<{
          revision: number;
          title: string;
          reason: string;
          actor: string;
          createdAt: number;
        }>;
      }>(`/api/documents/${documentId}/revisions`),
  });
  const restore = useMutation({
    mutationFn: (revision: number) => {
      if (blocked) throw new Error('Save or recover your changes before restoring a version.');
      onRestoring(true);
      return fetchJson(`/api/documents/${documentId}/revisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision, expectedRevision: currentRevision }),
      });
    },
    onSuccess: async () => {
      await onRestored();
      toast.success('Version restored as a new revision');
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => onRestoring(false),
  });
  return (
    <aside
      {...panel}
      aria-label="Version history"
      className="absolute inset-0 z-10 flex min-h-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)] @[900px]/document:static"
    >
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3 text-xs font-medium">
        Version history
        <Button variant="ghost" size="icon-xs" aria-label="Close version history" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </header>
      <div className="min-h-0 overflow-auto p-3">
        <p className="mb-4 text-xs leading-relaxed text-[var(--color-text-muted)]">
          Restoring creates a new revision. Your earlier versions remain available.
        </p>
        {blocked ? (
          <p role="status" className="mb-3 text-xs">
            Save or recover your current edits before restoring.
          </p>
        ) : null}
        {history.isLoading ? (
          <p role="status" className="text-xs">
            Loading versions…
          </p>
        ) : null}
        {history.error ? (
          <div role="alert" className="text-xs">
            Versions could not be loaded.
            <Button variant="outline" size="xs" onClick={() => void history.refetch()}>
              Retry
            </Button>
          </div>
        ) : null}
        {history.data?.revisions.map((revision) => (
          <article key={revision.revision} className="border-b border-[var(--color-border)] py-3">
            <div className="flex items-center justify-between gap-2 text-xs font-medium">
              <span>Revision {revision.revision}</span>
              {revision.revision === currentRevision ? (
                <span className="text-[var(--color-text-muted)]">Current</span>
              ) : null}
            </div>
            <p className="mt-1 text-xs">{revision.title}</p>
            <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{revision.reason}</p>
            <time
              className="mt-1 block text-[10px] text-[var(--color-text-faint)]"
              dateTime={new Date(revision.createdAt).toISOString()}
            >
              {new Date(revision.createdAt).toLocaleString()} · {revision.actor}
            </time>
            {revision.revision !== currentRevision ? (
              <Button
                className="mt-2"
                variant="outline"
                size="xs"
                disabled={blocked || restore.isPending}
                onClick={() => {
                  if (window.confirm(`Restore revision ${revision.revision} as a new revision?`))
                    restore.mutate(revision.revision);
                }}
              >
                Restore version
              </Button>
            ) : null}
          </article>
        ))}
      </div>
    </aside>
  );
}

function DocumentSuggestionReview({
  documentId,
  document,
  session,
  onChanged,
  blocked,
  onApplying,
}: {
  documentId: string;
  document: EditorDocument;
  session: SpreadsheetSession | null;
  onChanged: (revision?: number, options?: { engineCurrent?: boolean }) => Promise<void>;
  blocked: boolean;
  onApplying: (value: boolean) => void;
}) {
  const [localSuggestions, setLocalSuggestions] = useState(document.suggestions || []);
  useEffect(() => setLocalSuggestions(document.suggestions || []), [document.suggestions]);

  const decisionMutation = useMutation({
    mutationFn: async (input: { suggestionId: string; decision: 'apply' | 'dismiss' }) => {
      if (input.decision === 'apply' && blocked)
        throw new Error('Save your changes before applying a suggestion.');
      const suggestion = localSuggestions.find((item) => item.suggestionId === input.suggestionId);
      const changeSet =
        input.decision === 'apply' && suggestion?.proposedModel.kind === 'sheet-changes'
          ? suggestion.proposedModel
          : null;
      let engineModel: AlbatrossDocumentModel | undefined;
      if (changeSet) {
        if (!session) throw new Error('The spreadsheet is still opening. Try again in a moment.');
        // Apply through engine commands (each undoable), then persist the
        // resulting full snapshot bound to the suggestion's base revision.
        const outcome = applySheetChangeSet(session, changeSet);
        if (outcome.failed.length) {
          const first = outcome.failed[0];
          throw new Error(
            `${outcome.failed.length} of ${changeSet.changes.length} changes could not be applied (${first.sheet}${first.cell ? `!${first.cell}` : ''}: ${first.reason}). Nothing was changed.`,
          );
        }
        engineModel = session.snapshot();
      }
      if (input.decision === 'apply') onApplying(true);
      const result = await fetchJson<{ ok: true; document?: EditorDocument }>(
        `/api/documents/${documentId}/suggestions/${input.suggestionId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision: input.decision,
            expectedRevision: document.currentRevision,
            model: engineModel,
          }),
        },
      ).catch((error) => {
        if (changeSet && session) {
          // The server refused; take the engine back to the reviewed state.
          const steps = changeSet.changes.length + (changeSet.newSheets?.length || 0);
          for (let index = 0; index < steps; index += 1) session.model.dispatch('REQUEST_UNDO');
        }
        throw error;
      });
      return { ...input, revision: result.document?.currentRevision, engineCurrent: Boolean(changeSet) };
    },
    onSuccess: async (input) => {
      setLocalSuggestions((current) => current.filter((item) => item.suggestionId !== input.suggestionId));
      if (input.decision === 'apply') {
        toast.success('Suggestion applied');
        await onChanged(input.revision, { engineCurrent: input.engineCurrent });
      }
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => onApplying(false),
  });

  if (!localSuggestions.length) return null;
  return (
    <section
      aria-label="Suggested document edits"
      className="max-h-[40%] shrink-0 overflow-y-auto border-t border-[var(--color-border)] bg-[var(--color-content)] p-3"
    >
      <h2 className="text-xs font-medium">Suggested edits</h2>
      {blocked ? (
        <p role="status" className="mt-2 text-xs text-[var(--color-text-muted)]">
          Save or recover your edits before applying a suggestion.
        </p>
      ) : null}
      <div className="mt-2 space-y-2">
        {localSuggestions.length ? (
          localSuggestions.map((suggestion) => (
            <div
              key={suggestion.suggestionId}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3"
            >
              <div className="text-[12px] font-medium">{suggestion.title}</div>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                {suggestion.description}
              </p>
              {suggestion.proposedModel.kind === 'sheet-changes' ? (
                <SheetChangeList changeSet={suggestion.proposedModel} />
              ) : null}
              <div className="mt-3 flex gap-2">
                <Button
                  size="xs"
                  onClick={() =>
                    decisionMutation.mutate({ suggestionId: suggestion.suggestionId, decision: 'apply' })
                  }
                  disabled={
                    blocked ||
                    decisionMutation.isPending ||
                    suggestion.baseRevision !== document.currentRevision
                  }
                >
                  <Check className="size-3" /> Apply
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    decisionMutation.mutate({ suggestionId: suggestion.suggestionId, decision: 'dismiss' })
                  }
                  disabled={decisionMutation.isPending}
                >
                  Dismiss
                </Button>
              </div>
              {suggestion.baseRevision !== document.currentRevision ? (
                <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
                  This suggestion cannot be matched to your current revision. Ask for a fresh proposal to
                  preserve your newer work.
                </p>
              ) : null}
            </div>
          ))
        ) : (
          <div className="rounded-xl border border-dashed border-[var(--color-border)] px-3 py-5 text-center text-[11px] text-[var(--color-text-faint)]">
            No pending suggestions
          </div>
        )}
      </div>
    </section>
  );
}

function SheetChangeList({ changeSet }: { changeSet: SheetChangeSet }) {
  const shown = changeSet.changes.slice(0, 12);
  const remaining = changeSet.changes.length - shown.length;
  return (
    <div className="mt-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[11px]">
      {changeSet.newSheets?.length ? (
        <p className="mb-1 text-[var(--color-text-muted)]">New sheets: {changeSet.newSheets.join(', ')}</p>
      ) : null}
      <ul className="space-y-0.5 font-mono">
        {shown.map((change) => (
          <li key={`${change.sheet}!${change.cell}`} className="flex gap-2">
            <span className="shrink-0 text-[var(--color-text-muted)]">
              {change.sheet}!{change.cell}
            </span>
            <span className="min-w-0 truncate" title={change.content}>
              {change.content || '(clear)'}
            </span>
          </li>
        ))}
      </ul>
      {remaining > 0 ? (
        <p className="mt-1 text-[var(--color-text-muted)]">
          and {remaining} more {remaining === 1 ? 'change' : 'changes'}
        </p>
      ) : null}
    </div>
  );
}

interface GoogleEditorSuggestion {
  suggestionId: string;
  expectedProviderVersion: string;
  title: string;
  summary: string;
  model: AlbatrossDocumentModel;
}

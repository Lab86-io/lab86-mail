'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  CloudUpload,
  Download,
  ExternalLink,
  Presentation as FilePresentation,
  FileSpreadsheet,
  FileText,
  Loader2,
  PanelRight,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { toast } from 'sonner';
import { AlbatrossMark } from '@/components/albatross/AlbatrossMark';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { documentDraftMatchesSave } from '@/lib/documents/autosave';
import type {
  AlbatrossDocumentModel,
  AlbatrossDocumentRecord,
  DeckSlide,
  DocBlock,
  DocumentKind,
  DocumentSuggestion,
} from '@/lib/documents/model';
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

function KindIcon({ kind, className }: { kind: DocumentKind; className?: string }) {
  if (kind === 'sheet') return <FileSpreadsheet className={className} />;
  if (kind === 'deck') return <FilePresentation className={className} />;
  return <FileText className={className} />;
}

function kindName(kind: DocumentKind) {
  if (kind === 'sheet') return 'Spreadsheet';
  if (kind === 'deck') return 'Presentation';
  return 'Document';
}

export function paginateDocBlocks(
  blocks: DocBlock[],
  options: { charactersPerLine?: number; linesPerPage?: number } = {},
) {
  const charactersPerLine = options.charactersPerLine ?? 82;
  const linesPerPage = options.linesPerPage ?? 44;
  const pages: Array<Array<{ block: DocBlock; index: number }>> = [];
  let page: Array<{ block: DocBlock; index: number }> = [];
  let usedLines = 0;
  blocks.forEach((block, index) => {
    const explicitLines = Math.max(1, block.text.split('\n').length);
    const wrappedLines = Math.max(1, Math.ceil(block.text.length / charactersPerLine));
    const headingWeight = block.type === 'heading' ? (block.level === 1 ? 3 : 2) : 1;
    const estimatedLines = Math.max(explicitLines, wrappedLines) + headingWeight;
    if (page.length && usedLines + estimatedLines > linesPerPage) {
      pages.push(page);
      page = [];
      usedLines = 0;
    }
    page.push({ block, index });
    usedLines += estimatedLines;
  });
  if (page.length || !pages.length) pages.push(page);
  return pages;
}

export function DocumentEditor({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const revisionRef = useRef(0);
  const saveQueuedRef = useRef(false);
  const titleRef = useRef('');
  const modelRef = useRef<AlbatrossDocumentModel | null>(null);
  const [title, setTitle] = useState('');
  const [model, setModel] = useState<AlbatrossDocumentModel | null>(null);
  const [dirty, setDirty] = useState(false);
  const [aiOpen, setAiOpen] = useState(true);

  const documentQuery = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => fetchJson<{ ok: true; document: EditorDocument }>(`/api/documents/${documentId}`),
    staleTime: 10_000,
  });
  const document = documentQuery.data?.document;

  useEffect(() => {
    if (!document || dirty) return;
    setTitle(document.title);
    setModel(document.model);
    titleRef.current = document.title;
    modelRef.current = document.model;
    revisionRef.current = document.currentRevision;
  }, [dirty, document]);

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
      revisionRef.current = result.document.currentRevision;
      const latestMatchesSaved = documentDraftMatchesSave(
        { title: titleRef.current, model: modelRef.current },
        saved,
      );
      setDirty(!latestMatchesSaved);
      queryClient.setQueryData(['document', documentId], {
        ok: true,
        document: { ...document, ...result.document, suggestions: document?.suggestions || [] },
      });
    },
    onError: async (error: Error & { status?: number }) => {
      if (error.status === 409) {
        toast.error('This file changed somewhere else. The latest version has been reloaded.');
        setDirty(false);
        await documentQuery.refetch();
      } else {
        toast.error(error.message);
      }
    },
    onSettled: () => {
      if (saveQueuedRef.current) {
        saveQueuedRef.current = false;
        if (modelRef.current) {
          saveMutation.mutate({ title: titleRef.current, model: modelRef.current });
        }
      }
    },
  });

  const saveNow = useCallback(async () => {
    if (!dirty || !model) return true;
    if (saveMutation.isPending) {
      saveQueuedRef.current = true;
      return false;
    }
    const submitted = { title, model };
    try {
      await saveMutation.mutateAsync(submitted);
      return documentDraftMatchesSave({ title: titleRef.current, model: modelRef.current }, submitted);
    } catch {
      return false;
    }
  }, [dirty, model, saveMutation, title]);

  useEffect(() => {
    if (!dirty || !model) return;
    const timer = window.setTimeout(() => void saveNow(), 900);
    return () => window.clearTimeout(timer);
  }, [dirty, model, saveNow]);

  const editModel = useCallback((next: AlbatrossDocumentModel) => {
    modelRef.current = next;
    setModel(next);
    setDirty(true);
  }, []);

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
      await saveNow();
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

  if (documentQuery.error || (!documentQuery.isLoading && !document)) {
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

  return (
    <section aria-label={`${kindName(document.kind)} editor`} className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-14 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to Files"
          onClick={() => void saveNow().then((saved) => saved && onClose())}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <span className="grid size-8 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <KindIcon kind={document.kind} className="size-4" />
        </span>
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
                <Loader2 className="size-2.5 animate-spin" /> Saving
              </>
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
          disabled={publishMutation.isPending || saveMutation.isPending || dirty}
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
            disabled={pullGoogleMutation.isPending || saveMutation.isPending || dirty}
          >
            <RefreshCw className={cn('size-3.5', pullGoogleMutation.isPending && 'animate-spin')} />
          </Button>
        ) : null}
        <Button asChild variant="outline" size="icon-sm" title={`Download ${kindName(document.kind)}`}>
          <a href={`/api/documents/${documentId}/export`} aria-label={`Download ${kindName(document.kind)}`}>
            <Download className="size-3.5" />
          </a>
        </Button>
        <Button
          variant={aiOpen ? 'default' : 'outline'}
          size="sm"
          onClick={() => setAiOpen((current) => !current)}
          aria-pressed={aiOpen}
        >
          <span className="hidden sm:inline">Albatross</span>
        </Button>
      </header>

      <div
        className={cn(
          'grid min-h-0 flex-1',
          aiOpen ? 'grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]' : 'grid-cols-1',
        )}
      >
        <div className="min-h-0 overflow-hidden bg-[var(--color-bg-subtle)]">
          {model.kind === 'doc' ? <DocEditor model={model} onChange={editModel} /> : null}
          {model.kind === 'sheet' ? <SheetEditor model={model} onChange={editModel} /> : null}
          {model.kind === 'deck' ? <DeckEditor model={model} onChange={editModel} /> : null}
        </div>
        {aiOpen ? (
          <DocumentAiRail
            documentId={documentId}
            document={document}
            onChanged={async () => {
              setDirty(false);
              await documentQuery.refetch();
            }}
            onClose={() => setAiOpen(false)}
          />
        ) : null}
      </div>
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
  const saveQueuedRef = useRef(false);
  const titleRef = useRef('');
  const modelRef = useRef<AlbatrossDocumentModel | null>(null);
  const versionRef = useRef<string | undefined>(undefined);
  const [title, setTitle] = useState('');
  const [model, setModel] = useState<AlbatrossDocumentModel | null>(null);
  const [dirty, setDirty] = useState(false);
  const [aiOpen, setAiOpen] = useState(true);

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
  const file = fileQuery.data?.file;

  useEffect(() => {
    if (!file || dirty) return;
    setTitle(file.title);
    setModel(file.model);
    titleRef.current = file.title;
    modelRef.current = file.model;
    versionRef.current = file.providerVersion;
  }, [dirty, file]);

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
      versionRef.current = saved.providerVersion;
      const latestMatchesSaved = documentDraftMatchesSave(
        { title: titleRef.current, model: modelRef.current },
        submitted,
      );
      setDirty(!latestMatchesSaved);
      queryClient.setQueryData(queryKey, { ok: true, file: saved });
      void queryClient.invalidateQueries({ queryKey: ['cloud-files'] });
    },
    onError: async (error: Error & { status?: number }) => {
      if (error.status === 409) {
        toast.error('This file changed in Google Drive. Your unsaved edit was not overwritten.');
        const refreshed = await fileQuery.refetch();
        versionRef.current = refreshed.data?.file.providerVersion;
      } else {
        toast.error(error.message);
      }
    },
    onSettled: () => {
      if (saveQueuedRef.current && modelRef.current) {
        saveQueuedRef.current = false;
        saveMutation.mutate({ title: titleRef.current, model: modelRef.current });
      }
    },
  });

  const saveNow = useCallback(async () => {
    if (!dirty || !model) return true;
    if (saveMutation.isPending) {
      saveQueuedRef.current = true;
      return false;
    }
    const submitted = { title, model };
    try {
      await saveMutation.mutateAsync(submitted);
      return documentDraftMatchesSave({ title: titleRef.current, model: modelRef.current }, submitted);
    } catch {
      return false;
    }
  }, [dirty, model, saveMutation, title]);

  useEffect(() => {
    if (!dirty || !model) return;
    const timer = window.setTimeout(() => void saveNow(), 900);
    return () => window.clearTimeout(timer);
  }, [dirty, model, saveNow]);

  const editModel = useCallback((next: AlbatrossDocumentModel) => {
    modelRef.current = next;
    setModel(next);
    setDirty(true);
  }, []);

  if (fileQuery.error || (!fileQuery.isLoading && !file)) {
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

  return (
    <section aria-label={`${kindName(file.kind)} editor`} className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-14 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to Files"
          onClick={() => void saveNow().then((saved) => saved && onClose())}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <span className="grid size-8 place-items-center rounded-lg bg-blue-50 text-blue-600">
          <KindIcon kind={file.kind} className="size-4" />
        </span>
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
        <Button
          variant={aiOpen ? 'default' : 'outline'}
          size="sm"
          onClick={() => setAiOpen((current) => !current)}
          aria-pressed={aiOpen}
        >
          <span className="hidden sm:inline">Albatross</span>
        </Button>
      </header>
      <div
        className={cn(
          'grid min-h-0 flex-1',
          aiOpen ? 'grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]' : 'grid-cols-1',
        )}
      >
        <div className="min-h-0 overflow-hidden bg-[var(--color-bg-subtle)]">
          {model.kind === 'doc' ? <DocEditor model={model} onChange={editModel} /> : null}
          {model.kind === 'sheet' ? <SheetEditor model={model} onChange={editModel} /> : null}
          {model.kind === 'deck' ? <DeckEditor model={model} onChange={editModel} /> : null}
        </div>
        {aiOpen ? (
          <GoogleDocumentAiRail
            source={source}
            title={title}
            model={model}
            onApply={(suggestion) => {
              titleRef.current = suggestion.title;
              setTitle(suggestion.title);
              editModel(suggestion.proposedModel);
            }}
            onClose={() => setAiOpen(false)}
          />
        ) : null}
      </div>
    </section>
  );
}

function DocEditor({
  model,
  onChange,
}: {
  model: Extract<AlbatrossDocumentModel, { kind: 'doc' }>;
  onChange: (model: AlbatrossDocumentModel) => void;
}) {
  const updateBlock = (id: string, patch: Partial<DocBlock>) => {
    onChange({
      ...model,
      blocks: model.blocks.map((block) => (block.id === id ? { ...block, ...patch } : block)),
    });
  };
  const addBlock = (afterIndex: number, type: DocBlock['type'] = 'paragraph') => {
    const blocks = [...model.blocks];
    blocks.splice(afterIndex + 1, 0, { id: crypto.randomUUID(), type, text: '' });
    onChange({ ...model, blocks });
  };
  const pages = useMemo(() => paginateDocBlocks(model.blocks), [model.blocks]);
  return (
    <div className="h-full overflow-y-auto px-3 py-8 sm:px-8">
      {pages.map((page, pageIndex) => (
        <article
          key={`page-${page[0]?.block.id || pageIndex}`}
          aria-label={`Page ${pageIndex + 1}`}
          className="mx-auto mb-6 min-h-[1056px] max-w-[820px] bg-white px-8 py-12 text-slate-900 shadow-sm last:mb-8 sm:px-16 sm:py-16"
        >
          {page.map(({ block, index }) => (
            <div key={block.id} className="group relative">
              <div className="absolute -left-8 top-0 hidden items-center gap-0.5 opacity-0 group-hover:opacity-100 sm:flex">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Change block ${index + 1} type`}
                      className="rounded p-1 text-slate-400 hover:bg-slate-100"
                    >
                      <ChevronDown className="size-3" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {(['paragraph', 'heading', 'bullet', 'numbered', 'quote'] as const).map((type) => (
                      <DropdownMenuItem key={type} onSelect={() => updateBlock(block.id, { type })}>
                        {type[0].toUpperCase() + type.slice(1)}
                      </DropdownMenuItem>
                    ))}
                    {model.blocks.length > 1 ? (
                      <DropdownMenuItem
                        className="text-[var(--color-danger)]"
                        onSelect={() =>
                          onChange({
                            ...model,
                            blocks: model.blocks.filter((item) => item.id !== block.id),
                          })
                        }
                      >
                        <Trash2 className="size-3.5" /> Delete block
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <TextareaAutosize
                value={block.text}
                minRows={1}
                placeholder={
                  block.type === 'heading' ? 'Heading' : block.type === 'quote' ? 'Quote' : 'Start writing…'
                }
                onChange={(event) => updateBlock(block.id, { text: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && block.type !== 'paragraph') {
                    event.preventDefault();
                    addBlock(index);
                  }
                }}
                className={cn(
                  'mb-2 w-full resize-none overflow-hidden bg-transparent leading-relaxed outline-none placeholder:text-slate-300',
                  block.type === 'heading' &&
                    (block.level === 1
                      ? 'mt-5 text-3xl font-bold'
                      : block.level === 3
                        ? 'mt-3 text-lg font-semibold'
                        : 'mt-4 text-2xl font-semibold'),
                  block.type === 'bullet' && 'pl-5 before:content-["•"]',
                  block.type === 'numbered' && 'pl-5',
                  block.type === 'quote' && 'border-l-2 border-slate-300 pl-4 italic text-slate-600',
                  block.type === 'paragraph' && 'text-[15px]',
                )}
                aria-label={`${block.type} block ${index + 1}`}
              />
            </div>
          ))}
          {pageIndex === pages.length - 1 ? (
            <button
              type="button"
              onClick={() => addBlock(model.blocks.length - 1)}
              className="mt-4 flex items-center gap-1.5 rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-50 hover:text-slate-700"
            >
              <Plus className="size-3" /> Add block
            </button>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function SheetEditor({
  model,
  onChange,
}: {
  model: Extract<AlbatrossDocumentModel, { kind: 'sheet' }>;
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

function DeckEditor({
  model,
  onChange,
}: {
  model: Extract<AlbatrossDocumentModel, { kind: 'deck' }>;
  onChange: (model: AlbatrossDocumentModel) => void;
}) {
  const active = model.slides.find((slide) => slide.id === model.activeSlideId) || model.slides[0];
  const updateSlide = (patch: Partial<DeckSlide>) => {
    onChange({
      ...model,
      slides: model.slides.map((slide) => (slide.id === active.id ? { ...slide, ...patch } : slide)),
    });
  };
  const addSlide = () => {
    const id = crypto.randomUUID();
    const slide: DeckSlide = {
      id,
      title: `Slide ${model.slides.length + 1}`,
      elements: [
        {
          id: crypto.randomUUID(),
          type: 'text',
          role: 'title',
          x: 8,
          y: 10,
          width: 84,
          height: 16,
          text: 'New slide',
          fontSize: 32,
        },
        {
          id: crypto.randomUUID(),
          type: 'text',
          role: 'body',
          x: 10,
          y: 34,
          width: 80,
          height: 44,
          text: '',
          fontSize: 18,
        },
      ],
    };
    onChange({ ...model, activeSlideId: id, slides: [...model.slides, slide] });
  };
  return (
    <div className="grid h-full min-h-0 grid-cols-[112px_minmax(0,1fr)] sm:grid-cols-[172px_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-bg)] p-2">
        <div className="space-y-2">
          {model.slides.map((slide, index) => (
            <button
              key={slide.id}
              type="button"
              onClick={() => onChange({ ...model, activeSlideId: slide.id })}
              className="flex w-full items-start gap-1.5 text-left"
            >
              <span className="mt-1 w-4 text-right text-[9px] text-[var(--color-text-faint)]">
                {index + 1}
              </span>
              <span
                className={cn(
                  'relative aspect-video flex-1 overflow-hidden rounded border bg-white p-1 shadow-sm',
                  active.id === slide.id
                    ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]'
                    : 'border-[var(--color-border)]',
                )}
              >
                <span className="block truncate text-[5px] font-semibold text-slate-900">{slide.title}</span>
              </span>
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" className="mt-2 w-full text-[11px]" onClick={addSlide}>
          <Plus className="size-3" /> New slide
        </Button>
      </aside>
      <div className="flex min-h-0 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3 sm:p-8">
          <div
            className="relative aspect-video w-full max-w-[960px] shrink-0 overflow-hidden bg-white shadow-[0_12px_45px_rgba(15,23,42,0.16)]"
            style={{ background: active.background || '#ffffff' }}
          >
            {active.elements.map((element) =>
              element.type === 'shape' ? (
                <div
                  key={element.id}
                  className="absolute border border-slate-300"
                  style={{
                    left: `${element.x}%`,
                    top: `${element.y}%`,
                    width: `${element.width}%`,
                    height: `${element.height}%`,
                    background: element.fill || '#E8EEF5',
                  }}
                />
              ) : (
                <textarea
                  key={element.id}
                  aria-label={`${element.role || 'text'} element`}
                  value={element.text || ''}
                  onChange={(event) =>
                    updateSlide({
                      title: element.role === 'title' ? event.target.value || active.title : active.title,
                      elements: active.elements.map((candidate) =>
                        candidate.id === element.id ? { ...candidate, text: event.target.value } : candidate,
                      ),
                    })
                  }
                  className={cn(
                    'absolute resize-none overflow-hidden bg-transparent p-1 text-slate-900 outline-none focus:ring-1 focus:ring-blue-400',
                    element.role === 'title' && 'font-semibold',
                  )}
                  style={
                    {
                      left: `${element.x}%`,
                      top: `${element.y}%`,
                      width: `${element.width}%`,
                      height: `${element.height}%`,
                      fontSize: `clamp(10px, ${(element.fontSize || 16) / 35}vw, ${element.fontSize || 16}px)`,
                      color: element.color || '#17202A',
                    } as CSSProperties
                  }
                />
              ),
            )}
          </div>
        </div>
        <div className="flex h-11 shrink-0 items-center gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              updateSlide({
                elements: [
                  ...active.elements,
                  {
                    id: crypto.randomUUID(),
                    type: 'text',
                    role: 'body',
                    x: 10,
                    y: 40,
                    width: 80,
                    height: 20,
                    text: 'Text',
                    fontSize: 18,
                  },
                ],
              })
            }
          >
            <Plus className="size-3.5" /> Text
          </Button>
          <input
            aria-label="Speaker notes"
            value={active.notes || ''}
            onChange={(event) => updateSlide({ notes: event.target.value })}
            placeholder="Speaker notes"
            className="ml-auto h-7 min-w-0 max-w-md flex-1 rounded border border-[var(--color-control-border)] bg-[var(--color-control)] px-2 text-xs outline-none"
          />
          {model.slides.length > 1 ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Delete slide"
              onClick={() => {
                const slides = model.slides.filter((slide) => slide.id !== active.id);
                onChange({ ...model, activeSlideId: slides[0].id, slides });
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DocumentAiRail({
  documentId,
  document,
  onChanged,
  onClose,
}: {
  documentId: string;
  document: EditorDocument;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [localSuggestions, setLocalSuggestions] = useState(document.suggestions || []);
  useEffect(() => setLocalSuggestions(document.suggestions || []), [document.suggestions]);

  const suggestMutation = useMutation({
    mutationFn: () =>
      fetchJson<{ ok: true; suggestion: DocumentSuggestion }>(`/api/documents/${documentId}/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction, mode: 'suggest' }),
      }),
    onSuccess: ({ suggestion }) => {
      setLocalSuggestions((current) => [suggestion, ...current]);
      setInstruction('');
      toast.success('Suggestion ready to review');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const decisionMutation = useMutation({
    mutationFn: (input: { suggestionId: string; decision: 'apply' | 'dismiss' }) =>
      fetchJson(`/api/documents/${documentId}/suggestions/${input.suggestionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: input.decision }),
      }).then(() => input),
    onSuccess: async (input) => {
      setLocalSuggestions((current) => current.filter((item) => item.suggestionId !== input.suggestionId));
      if (input.decision === 'apply') {
        toast.success('Suggestion applied');
        await onChanged();
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <aside className="flex min-h-0 flex-col border-t border-[var(--color-border)] bg-[var(--color-bg)] lg:border-l lg:border-t-0">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <AlbatrossMark className="size-3.5 text-[var(--color-accent)]" />
        <span className="text-[12.5px] font-medium">Albatross editor</span>
        <Button
          className="ml-auto"
          variant="ghost"
          size="icon-xs"
          aria-label="Close AI editor"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <p className="text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
          Ask for a rewrite, analysis, formula pass, or new slides. Albatross proposes a complete revision and
          waits for you to apply it.
        </p>
        <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-2">
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder={
              document.kind === 'sheet'
                ? 'e.g. Add a forecast tab with formulas'
                : document.kind === 'deck'
                  ? 'e.g. Turn this into a 6-slide client narrative'
                  : 'e.g. Make this concise and add an executive summary'
            }
            rows={4}
            className="w-full resize-none bg-transparent text-[12px] leading-relaxed outline-none placeholder:text-[var(--color-text-faint)]"
          />
          <Button
            size="sm"
            className="mt-2 w-full"
            onClick={() => suggestMutation.mutate()}
            disabled={!instruction.trim() || suggestMutation.isPending}
          >
            {suggestMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Propose changes
          </Button>
        </div>
        <div className="mt-5 flex items-center gap-2">
          <PanelRight className="size-3.5 text-[var(--color-text-faint)]" />
          <h2 className="text-[11px] font-medium text-[var(--color-text-faint)]">Suggestions</h2>
        </div>
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
                <div className="mt-3 flex gap-2">
                  <Button
                    size="xs"
                    onClick={() =>
                      decisionMutation.mutate({ suggestionId: suggestion.suggestionId, decision: 'apply' })
                    }
                    disabled={decisionMutation.isPending}
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
              </div>
            ))
          ) : (
            <div className="rounded-xl border border-dashed border-[var(--color-border)] px-3 py-5 text-center text-[11px] text-[var(--color-text-faint)]">
              No pending suggestions
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

interface GoogleDocumentSuggestion {
  suggestionId: string;
  title: string;
  description: string;
  proposedModel: AlbatrossDocumentModel;
}

function GoogleDocumentAiRail({
  source,
  title,
  model,
  onApply,
  onClose,
}: {
  source: GoogleEditorSource;
  title: string;
  model: AlbatrossDocumentModel;
  onApply: (suggestion: GoogleDocumentSuggestion) => void;
  onClose: () => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [suggestions, setSuggestions] = useState<GoogleDocumentSuggestion[]>([]);
  const suggestMutation = useMutation({
    mutationFn: () =>
      fetchJson<{ ok: true; suggestion: GoogleDocumentSuggestion }>('/api/files/google/editor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...source, title, model, instruction }),
      }),
    onSuccess: ({ suggestion }) => {
      setSuggestions((current) => [suggestion, ...current]);
      setInstruction('');
      toast.success('Suggestion ready to review');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <aside className="flex min-h-0 flex-col border-t border-[var(--color-border)] bg-[var(--color-bg)] lg:border-l lg:border-t-0">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <AlbatrossMark className="size-3.5 text-[var(--color-accent)]" />
        <span className="text-[12.5px] font-medium">Albatross editor</span>
        <Button
          className="ml-auto"
          variant="ghost"
          size="icon-xs"
          aria-label="Close AI editor"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <p className="text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
          Proposed changes stay local until you apply them. Applied edits save back to this same Google file.
        </p>
        <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-2">
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder={
              model.kind === 'sheet'
                ? 'e.g. Add a forecast tab with formulas'
                : model.kind === 'deck'
                  ? 'e.g. Turn this into a 6-slide client narrative'
                  : 'e.g. Make this concise and add an executive summary'
            }
            rows={4}
            className="w-full resize-none bg-transparent text-[12px] leading-relaxed outline-none placeholder:text-[var(--color-text-faint)]"
          />
          <Button
            size="sm"
            className="mt-2 w-full"
            onClick={() => suggestMutation.mutate()}
            disabled={!instruction.trim() || suggestMutation.isPending}
          >
            {suggestMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Propose changes
          </Button>
        </div>
        <div className="mt-5 flex items-center gap-2">
          <PanelRight className="size-3.5 text-[var(--color-text-faint)]" />
          <h2 className="text-[11px] font-medium text-[var(--color-text-faint)]">Suggestions</h2>
        </div>
        <div className="mt-2 space-y-2">
          {suggestions.length ? (
            suggestions.map((suggestion) => (
              <div
                key={suggestion.suggestionId}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3"
              >
                <div className="text-[12px] font-medium">{suggestion.title}</div>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                  {suggestion.description}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="xs"
                    onClick={() => {
                      onApply(suggestion);
                      setSuggestions((current) =>
                        current.filter((candidate) => candidate.suggestionId !== suggestion.suggestionId),
                      );
                      toast.success('Suggestion applied; saving to Google Drive');
                    }}
                  >
                    <Check className="size-3" /> Apply
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      setSuggestions((current) =>
                        current.filter((candidate) => candidate.suggestionId !== suggestion.suggestionId),
                      )
                    }
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-xl border border-dashed border-[var(--color-border)] px-3 py-5 text-center text-[11px] text-[var(--color-text-faint)]">
              No pending suggestions
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

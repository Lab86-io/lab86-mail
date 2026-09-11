'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download, History, Loader2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CollaboraFrame, type CollaboraHandle, type CollaboraSession } from './CollaboraFrame';

interface OfficeMetadata {
  title: string;
  currentRevision: number;
  versions: Array<{ revision: number; recovery: boolean; createdAt: number }>;
  google?: { fileId: string; syncedRevision: number };
}
interface OfficeInstance {
  destroyEditor: () => void;
}
type OfficeWindow = Window & {
  DocsAPI?: { DocEditor: new (id: string, config: Record<string, unknown>) => OfficeInstance };
};
const scripts = new Map<string, Promise<void>>();

function loadOffice(server: string) {
  const source = `${server}/web-apps/apps/api/documents/api.js`;
  if (!scripts.has(source))
    scripts.set(
      source,
      new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = source;
        script.async = true;
        const timer = setTimeout(() => {
          scripts.delete(source);
          script.remove();
          reject(new Error('The Office service did not respond.'));
        }, 20_000);
        script.onload = () => {
          clearTimeout(timer);
          resolve();
        };
        script.onerror = () => {
          clearTimeout(timer);
          scripts.delete(source);
          script.remove();
          reject(new Error('The Office service could not be loaded.'));
        };
        document.head.appendChild(script);
      }),
    );
  return scripts.get(source)!;
}

export function OfficeEditor({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const id = `office-${useId().replace(/[^a-z0-9]/giu, '')}`;
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [changed, setChanged] = useState(false);
  const [history, setHistory] = useState(false);
  const [retry, setRetry] = useState(0);
  const [collabora, setCollabora] = useState<CollaboraSession | null>(null);
  const [saving, setSaving] = useState(false);
  const collaboraRef = useRef<CollaboraHandle>(null);
  const savingRef = useRef(false);
  const initialRevision = useRef<number | null>(null);
  const file = useQuery({
    queryKey: ['office-document', documentId],
    queryFn: async () => {
      const response = await fetch(`/api/office/${documentId}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'This Office file could not be opened.');
      return result.document as OfficeMetadata;
    },
    refetchInterval: 5000,
  });
  useEffect(() => {
    if (file.data && initialRevision.current === null) initialRevision.current = file.data.currentRevision;
  }, [file.data]);

  const close = () => {
    if (
      (changed || saving) &&
      !window.confirm(
        'The editor may still be saving. Stay here to save, or leave and check Versions for the saved copy. Leave editor?',
      )
    )
      return;
    onClose();
  };

  useEffect(() => {
    void retry; // An explicit retry starts a fresh, document-bound session.
    let disposed = false;
    let editor: OfficeInstance | undefined;
    const controller = new AbortController();
    setReady(false);
    setError(null);
    void (async () => {
      try {
        const response = await fetch(`/api/office/${documentId}/session`, {
          method: 'POST',
          signal: controller.signal,
        });
        const session = await response.json();
        if (!response.ok) throw new Error(session.error || 'Office could not start.');
        if (disposed) return;
        if (session.provider === 'collabora') {
          setCollabora(session);
          return;
        }
        await loadOffice(session.serverUrl);
        if (disposed) return;
        const api = (window as OfficeWindow).DocsAPI;
        if (!api) throw new Error('Office did not expose an editor.');
        editor = new api.DocEditor(id, {
          ...session.config,
          events: {
            onDocumentReady: () => setReady(true),
            onDocumentStateChange: (event: { data?: boolean }) => {
              if (event.data) setChanged(true);
            },
            onError: () =>
              setError(
                'Office reported an error. Keep this window open and download a recovery copy from the editor if necessary.',
              ),
          },
        });
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : 'Office could not open.');
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
      editor?.destroyEditor();
    };
  }, [documentId, id, retry]);

  useEffect(() => {
    if (!changed && !saving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [changed, saving]);

  const save = async () => {
    if (!collaboraRef.current || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const saveId = await collaboraRef.current.save();
      if (file.data?.google) {
        const response = await fetch(`/api/office/${documentId}/google`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ saveId }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Google could not save your edits.');
      }
      await file.refetch();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Save failed.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <section
      aria-label="Office editing workspace"
      className="flex h-full min-h-0 flex-col bg-[var(--color-bg)]"
    >
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <Button variant="ghost" size="icon-sm" aria-label="Back to Files" onClick={close}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">{file.data?.title || 'Office working copy'}</h1>
          <p aria-live="polite" className="text-[11px] text-[var(--color-text-muted)]">
            {file.data ? `Saved copy · revision ${file.data.currentRevision}` : 'Opening saved copy…'}
            {changed ? ' · editor may have newer changes' : ''}
          </p>
        </div>
        {collabora ? (
          <Button size="sm" disabled={!ready || saving} onClick={() => void save()}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {saving ? 'Saving…' : file.data?.google ? 'Save to Google' : 'Save'}
          </Button>
        ) : null}
        <Button asChild variant="outline" size="icon-sm">
          <a aria-label="Download saved Office copy" href={`/api/office/${documentId}/content`}>
            <Download className="size-4" />
          </a>
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={history}
          onClick={() => setHistory((value) => !value)}
        >
          <History className="size-4" />
          <span className="hidden sm:inline">Versions</span>
        </Button>
      </header>
      <div className="border-b border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-text-muted)]">
        {file.data?.google
          ? file.data.google.syncedRevision < file.data.currentRevision
            ? 'Edits saved in Albatross. Click Save to Google to update the original.'
            : 'Google working copy. Click Save to Google when your edits are ready.'
          : 'Private working copy. Your original is retained in Versions.'}
      </div>
      {error || file.error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-3 text-xs"
        >
          <span className="flex-1">{error || file.error?.message}</span>
          {!ready ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                setRetry((value) => value + 1);
                void file.refetch();
              }}
            >
              Retry editor
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {collabora ? (
            <CollaboraFrame
              ref={collaboraRef}
              session={collabora}
              onReady={setReady}
              onModified={setChanged}
              onError={setError}
            />
          ) : (
            <div id={id} className="h-full" />
          )}
          {!ready && !error ? (
            <div
              role="status"
              className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-[var(--color-bg)] text-xs"
            >
              <Loader2 className="size-4 animate-spin" />
              Opening Office editor…
            </div>
          ) : null}
        </div>
        {history ? (
          <aside
            aria-label="Office versions"
            className="absolute inset-0 z-10 overflow-auto border-l border-[var(--color-border)] bg-[var(--color-bg)] p-3 sm:static sm:w-72"
          >
            <header className="flex items-center justify-between text-xs font-medium">
              Versions
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close versions"
                onClick={() => setHistory(false)}
              >
                <X className="size-3.5" />
              </Button>
            </header>
            <p className="mt-2 text-xs text-[var(--color-text-muted)]">
              Conflicting saves are kept as recovery copies, never used to overwrite newer work.
            </p>
            {file.data?.versions.map((version) => (
              <div key={version.revision} className="border-b border-[var(--color-border)] py-3 text-xs">
                <p>
                  Revision {version.revision}
                  {version.revision === 1
                    ? ' · Original'
                    : version.recovery
                      ? ' · Recovery copy'
                      : version.revision === file.data.currentRevision
                        ? ' · Current'
                        : ''}
                </p>
                <time className="mt-1 block text-[11px] text-[var(--color-text-muted)]">
                  {new Date(version.createdAt).toLocaleString()}
                </time>
                <Button asChild className="mt-2" variant="outline" size="xs">
                  <a href={`/api/office/${documentId}/content?revision=${version.revision}`}>
                    Download version
                  </a>
                </Button>
              </div>
            ))}
          </aside>
        ) : null}
      </div>
    </section>
  );
}

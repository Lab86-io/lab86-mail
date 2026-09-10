'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { SheetGridModel, SheetWorkbookModel } from '@/lib/documents/model';
import {
  createSpreadsheetSession,
  loadSpreadsheetEngine,
  type SpreadsheetSession,
} from '@/lib/documents/odoo-spreadsheet-engine';
import { ODOO_SPREADSHEET_ASSET_BASE, ODOO_SPREADSHEET_VERSION } from '@/lib/documents/sheet-workbook';
import { cn } from '@/lib/utils';

export interface OdooSpreadsheetEditorProps {
  model: SheetGridModel | SheetWorkbookModel;
  /**
   * Identity of the loaded state. Change it only when the model was replaced
   * from outside the engine (open, restore, AI apply, reload); the engine
   * owns the state between those points and must not be rebuilt on its own
   * change echoes.
   */
  sessionKey: string;
  readOnly?: boolean;
  onChange: (next: SheetWorkbookModel) => void;
  onSession?: (session: SpreadsheetSession | null) => void;
  className?: string;
}

/**
 * React host for the Owl-based o-spreadsheet component.
 *
 * Lifecycle: one Owl App per (sessionKey, retry). The effect creates the model
 * and app, mounts into a container React never re-renders, and on cleanup
 * destroys the app and leaves the model session. Strict-mode double invocation
 * therefore yields exactly one live editor; an unmount during the async engine
 * load disposes the session before it mounts.
 */
export function OdooSpreadsheetEditor({
  model,
  sessionKey,
  readOnly = false,
  onChange,
  onSession,
  className,
}: OdooSpreadsheetEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SpreadsheetSession | null>(null);
  const modelRef = useRef(model);
  const onChangeRef = useRef(onChange);
  const onSessionRef = useRef(onSession);
  const readOnlyRef = useRef(readOnly);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  modelRef.current = model;
  onChangeRef.current = onChange;
  onSessionRef.current = onSession;
  readOnlyRef.current = readOnly;

  useEffect(() => {
    // sessionKey and retry are identity inputs: a new value means "rebuild
    // the engine from modelRef", not "re-read a value inside the effect".
    void sessionKey;
    void retry;
    let disposed = false;
    let session: SpreadsheetSession | null = null;
    setStatus('loading');
    setError(null);
    void (async () => {
      try {
        const loaded = await loadSpreadsheetEngine();
        if (disposed) return;
        session = createSpreadsheetSession({
          loaded,
          model: modelRef.current,
          readOnly: readOnlyRef.current,
          onContentChange: () => {
            if (!session || disposed) return;
            onChangeRef.current(session.snapshot());
          },
          notifyUser: (notification) => {
            const show =
              notification.type === 'danger'
                ? toast.error
                : notification.type === 'warning'
                  ? toast.warning
                  : notification.type === 'success'
                    ? toast.success
                    : toast.info;
            show(notification.text, notification.sticky ? { duration: Number.POSITIVE_INFINITY } : undefined);
          },
          raiseError: (text, callback) => {
            toast.error(text);
            callback?.();
          },
          askConfirmation: (content, confirm, cancel) => {
            if (window.confirm(content)) confirm();
            else cancel?.();
          },
        });
        sessionRef.current = session;
        const container = containerRef.current;
        if (!container) throw new Error('The spreadsheet container is missing.');
        await session.mount(container);
        if (disposed) return;
        session.setReadOnly(readOnlyRef.current);
        onSessionRef.current?.(session);
        setStatus('ready');
      } catch (reason) {
        if (disposed) return;
        setError(reason instanceof Error ? reason.message : 'The spreadsheet could not be opened.');
        setStatus('error');
      }
    })();
    return () => {
      disposed = true;
      onSessionRef.current?.(null);
      const current = session;
      sessionRef.current = null;
      session = null;
      if (current) void current.dispose();
      containerRef.current?.replaceChildren();
    };
  }, [sessionKey, retry]);

  useEffect(() => {
    sessionRef.current?.setReadOnly(readOnly);
  }, [readOnly]);

  return (
    <div className={cn('relative flex h-full min-h-0 min-w-0 flex-col', className)}>
      <div
        ref={containerRef}
        data-spreadsheet-engine={`o-spreadsheet ${ODOO_SPREADSHEET_VERSION}`}
        className="albatross-sheet-frame h-full min-h-0 min-w-0 flex-1 bg-white text-[#374151]"
      />
      <div className="flex shrink-0 justify-end border-t border-[var(--color-border)] px-3 py-1 text-[11px] text-[var(--color-text-muted)]">
        <a
          href={`${ODOO_SPREADSHEET_ASSET_BASE}/NOTICE.md`}
          target="_blank"
          rel="noreferrer"
          className="rounded-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Odoo · source and licenses
        </a>
      </div>
      {status !== 'ready' ? (
        <div
          role={status === 'error' ? 'alert' : 'status'}
          className="absolute inset-0 z-10 grid place-items-center bg-[var(--color-bg-subtle)] p-6 text-center text-[12.5px] text-[var(--color-text-muted)]"
        >
          {status === 'error' ? (
            <div>
              <p className="font-medium text-[var(--color-text)]">The spreadsheet engine did not open.</p>
              <p className="mt-1">{error}</p>
              <Button className="mt-3" variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" /> Opening spreadsheet…
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

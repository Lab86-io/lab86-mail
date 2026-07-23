'use client';

import { Undo2 } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { callTool } from '@/lib/api-client';
import { type ComposeMode, useClientStore } from '@/lib/client-state';

type PendingReceipt = {
  id: string;
  fireAt: number;
  undoSeconds: number;
};

export type DurableComposeDraft = {
  mode: ComposeMode;
  account: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  threadId?: string | null;
  anchorMessageId?: string | null;
  files: File[];
  draftId?: string | null;
};

type DurablePendingSend = PendingReceipt & {
  draft: DurableComposeDraft;
  status?: 'pending' | 'sent' | 'failed' | 'cancelled' | 'unknown';
};

type PendingSendContextValue = {
  registerPendingSend: (receipt: PendingReceipt, draft: DurableComposeDraft) => Promise<void>;
};

const PendingSendContext = createContext<PendingSendContextValue | null>(null);
const DATABASE_NAME = 'albatross-compose';
const STORE_NAME = 'pending-sends';

export function usePendingSend() {
  const value = useContext(PendingSendContext);
  if (!value) throw new Error('usePendingSend must be used within PendingSendProvider');
  return value;
}

export function PendingSendProvider({ children }: { children: ReactNode }) {
  const [records, setRecords] = useState<DurablePendingSend[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const openComposeNew = useClientStore((state) => state.openComposeNew);
  const openComposeReply = useClientStore((state) => state.openComposeReply);
  const setComposeRecoveredFiles = useClientStore((state) => state.setComposeRecoveredFiles);

  const remove = useCallback(async (id: string) => {
    await deleteRecord(id).catch(() => undefined);
    setRecords((current) => current.filter((record) => record.id !== id));
  }, []);

  const restore = useCallback(
    async (record: DurablePendingSend) => {
      setComposeRecoveredFiles(record.draft.files);
      const prefill = {
        to: record.draft.to,
        cc: record.draft.cc,
        bcc: record.draft.bcc,
        subject: record.draft.subject,
        body: record.draft.body,
      };
      if (record.draft.mode !== 'new' && record.draft.threadId && record.draft.anchorMessageId) {
        openComposeReply({
          mode: record.draft.mode,
          threadId: record.draft.threadId,
          messageId: record.draft.anchorMessageId,
          account: record.draft.account,
          prefill,
        });
      } else {
        openComposeNew(prefill);
      }
      await remove(record.id);
      toast.success(
        record.draft.files.length
          ? 'Send cancelled — draft and attachments restored'
          : 'Send cancelled — draft restored',
      );
    },
    [openComposeNew, openComposeReply, remove, setComposeRecoveredFiles],
  );

  const reconcile = useCallback(async () => {
    const stored = await loadRecords().catch(() => [] as DurablePendingSend[]);
    const visible: DurablePendingSend[] = [];
    for (const record of stored) {
      try {
        const response = await fetch(`/api/compose/status?pendingId=${encodeURIComponent(record.id)}`, {
          cache: 'no-store',
        });
        if (response.status === 401) continue;
        if (response.status === 404) {
          await deleteRecord(record.id);
          continue;
        }
        const result = await response.json().catch(() => null);
        const status = result?.status as DurablePendingSend['status'];
        if (status === 'sent') {
          if (record.draft.draftId) {
            void deleteServerDraft(record.draft.draftId);
          }
          await deleteRecord(record.id);
          continue;
        }
        visible.push({ ...record, status: status || 'unknown' });
      } catch {
        // Offline state is honest but does not destroy the only durable copy.
        visible.push({ ...record, status: record.status || 'unknown' });
      }
    }
    setRecords(visible.sort((a, b) => a.fireAt - b.fireAt));
  }, []);

  useEffect(() => {
    void reconcile();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reconcile();
    };
    window.addEventListener('online', reconcile);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', reconcile);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reconcile]);

  useEffect(() => {
    if (!records.length) return;
    const timer = window.setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (records.some((record) => record.fireAt <= next && record.status === 'pending')) {
        void reconcile();
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [records, reconcile]);

  const registerPendingSend = useCallback(async (receipt: PendingReceipt, draft: DurableComposeDraft) => {
    const record: DurablePendingSend = { ...receipt, draft, status: 'pending' };
    await saveRecord(record).catch(() => undefined);
    setRecords((current) =>
      [...current.filter((item) => item.id !== receipt.id), record].sort((a, b) => a.fireAt - b.fireAt),
    );
  }, []);

  const undo = useCallback(
    async (record: DurablePendingSend) => {
      try {
        const response = await fetch('/api/compose/undo', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pendingId: record.id }),
        });
        const result = await response.json().catch(() => null);
        if (response.ok && result?.undone) {
          await restore(record);
          return;
        }
        toast.error('The server says this message is already sending.');
        await reconcile();
      } catch {
        toast.error('Could not reach the server. The message was not marked cancelled.');
      }
    },
    [reconcile, restore],
  );

  const value = useMemo(() => ({ registerPendingSend }), [registerPendingSend]);

  return (
    <PendingSendContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[120] ml-auto flex max-w-[28rem] flex-col gap-2 sm:left-auto sm:right-4"
        aria-live="polite"
      >
        {records.map((record) => {
          const seconds = Math.max(0, Math.ceil((record.fireAt - now) / 1_000));
          const canUndo = record.status === 'pending' && seconds > 0;
          const recoverable = record.status === 'failed' || record.status === 'cancelled';
          return (
            <section
              key={record.id}
              className="pointer-events-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3 shadow-xl"
            >
              <div className="flex items-center gap-3">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--color-accent)]/12 text-[var(--color-accent)]">
                  <Undo2 className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-medium text-[var(--color-text)]">
                    {canUndo
                      ? `Sending in ${seconds}s`
                      : recoverable
                        ? record.status === 'failed'
                          ? 'Send failed'
                          : 'Send cancelled'
                        : 'Confirming send…'}
                  </p>
                  <p className="truncate text-[11px] text-[var(--color-text-faint)]">
                    {record.draft.subject || 'Message held by the server'}
                  </p>
                </div>
                {canUndo ? (
                  <button
                    type="button"
                    onClick={() => void undo(record)}
                    className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-white"
                  >
                    Undo Send
                  </button>
                ) : recoverable ? (
                  <button
                    type="button"
                    onClick={() => void restore(record)}
                    className="rounded-md border border-[var(--color-control-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-text)]"
                  >
                    Restore draft
                  </button>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </PendingSendContext.Provider>
  );
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return await new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error);
  });
}

function saveRecord(record: DurablePendingSend) {
  return withStore('readwrite', (store) => store.put(record));
}

function deleteRecord(id: string) {
  return withStore('readwrite', (store) => store.delete(id));
}

function loadRecords() {
  return withStore<DurablePendingSend[]>('readonly', (store) => store.getAll());
}

async function deleteServerDraft(id: string) {
  await callTool('delete_draft', { id }).catch(() => undefined);
}

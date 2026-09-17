'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { callTool } from '@/lib/api-client';
import { type ComposeMode, useClientStore } from '@/lib/client-state';
import { fireSendEffect } from '@/lib/effects/send-effect';
import { PendingSendToast } from './PendingSendToast';

type PendingReceipt = {
  id: string;
  fireAt: number;
  undoSeconds: number;
  status?: 'preparing' | 'pending' | 'cancelled';
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

export type DurablePendingSend = Omit<PendingReceipt, 'status'> & {
  draft: DurableComposeDraft;
  status?: 'preparing' | 'sending' | 'pending' | 'sent' | 'failed' | 'cancelled' | 'unknown';
};

type PendingSendContextValue = {
  registerPendingSend: (receipt: PendingReceipt, draft: DurableComposeDraft) => Promise<boolean>;
  cancelPendingSend: (id: string) => Promise<boolean>;
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
  const recordsRef = useRef(new Map<string, DurablePendingSend>());
  const removed = useRef(new Set<string>());
  const checking = useRef(new Set<string>());
  const cancellingRef = useRef(new Set<string>());
  const [cancelling, setCancelling] = useState(new Set<string>());
  const [now, setNow] = useState(() => Date.now());
  const queryClient = useQueryClient();

  const publish = useCallback(() => {
    setRecords([...recordsRef.current.values()].sort((a, b) => a.fireAt - b.fireAt));
    setNow(Date.now());
  }, []);

  const remove = useCallback(
    (id: string) => {
      removed.current.add(id);
      recordsRef.current.delete(id);
      publish();
      void deleteRecord(id).catch(() => undefined);
    },
    [publish],
  );

  const restore = useCallback(
    (record: DurablePendingSend) => {
      const { draft } = record;
      const state = useClientStore.getState();
      const prefill = {
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        body: draft.body,
      };
      // One atomic update preserves the sending account, reply anchor, and files.
      useClientStore.setState({
        compose: {
          mode: draft.mode,
          anchorThreadId: draft.threadId || null,
          anchorMessageId: draft.anchorMessageId || null,
          anchorAccount: draft.account,
          prefill,
          nonce: state.compose.nonce + 1,
        },
        composeRecoveredFiles: draft.files,
        ...(draft.threadId ? { selectedThreadId: draft.threadId, threadAccount: draft.account } : {}),
      });
      remove(record.id);
      toast.success(record.status === 'failed' ? 'Draft restored' : 'Send cancelled — draft restored');
    },
    [remove],
  );

  const reconcile = useCallback(async () => {
    await Promise.all(
      [...recordsRef.current.values()].map(async (record) => {
        if (checking.current.has(record.id) || cancellingRef.current.has(record.id)) return;
        if (record.status === 'preparing') return;
        if (record.status === 'failed' || record.status === 'cancelled') return;
        checking.current.add(record.id);
        try {
          const response = await fetch(`/api/compose/status?pendingId=${encodeURIComponent(record.id)}`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(10_000),
          });
          // A response started before Undo must never resurrect or celebrate it.
          if (recordsRef.current.get(record.id) !== record || cancellingRef.current.has(record.id)) return;
          if (response.status === 401) {
            recordsRef.current.delete(record.id);
            publish();
            return;
          }
          if (response.status === 404) {
            remove(record.id);
            return;
          }
          const result = await response.json();
          if (!response.ok || result?.ok === false) return;
          if (recordsRef.current.get(record.id) !== record || cancellingRef.current.has(record.id)) return;
          if (result.status === 'sent') {
            remove(record.id);
            if (record.draft.draftId) void deleteServerDraft(record.draft.draftId);
            void queryClient.invalidateQueries({ queryKey: ['thread'] });
            void queryClient.invalidateQueries({ queryKey: ['search'] });
            toast.success('Message sent');
            fireSendEffect();
          } else if (['pending', 'sending', 'unknown', 'failed', 'cancelled'].includes(result.status)) {
            const updated = { ...record, status: result.status };
            recordsRef.current.set(record.id, updated);
            publish();
            void saveRecord(updated).catch(() => undefined);
          }
        } catch {
          // Keep the in-memory receipt even when IndexedDB or the network is unavailable.
          // Time passing alone is never evidence that a message was delivered.
        } finally {
          checking.current.delete(record.id);
        }
      }),
    );
  }, [publish, queryClient, remove]);

  useEffect(() => {
    let active = true;
    const hydrate = async () => {
      const stored = await loadRecords().catch(() => [] as DurablePendingSend[]);
      if (!active) return;
      for (const record of stored) {
        if (!removed.current.has(record.id) && !recordsRef.current.has(record.id)) {
          recordsRef.current.set(record.id, {
            ...record,
            status: record.status === 'preparing' ? 'unknown' : record.status,
          });
        }
      }
      publish();
      void reconcile();
    };
    void hydrate();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void hydrate();
    };
    window.addEventListener('online', hydrate);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      window.removeEventListener('online', hydrate);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [publish, reconcile]);

  useEffect(() => {
    if (!records.length) return;
    const timer = window.setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (
        [...recordsRef.current.values()].some(
          (record) => record.fireAt <= next && record.status !== 'failed' && record.status !== 'cancelled',
        )
      ) {
        void reconcile();
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [records.length, reconcile]);

  const registerPendingSend = useCallback(
    async (receipt: PendingReceipt, draft: DurableComposeDraft) => {
      if (removed.current.has(receipt.id)) return false;
      const record: DurablePendingSend = { ...receipt, draft, status: receipt.status || 'pending' };
      recordsRef.current.set(receipt.id, record);
      publish();
      // Storage must not delay the user's opportunity to undo a short window.
      void saveRecord(record).catch(() => undefined);
      return true;
    },
    [publish],
  );

  const undo = useCallback(
    async (record: DurablePendingSend) => {
      if (cancellingRef.current.has(record.id)) return false;
      cancellingRef.current.add(record.id);
      setCancelling(new Set(cancellingRef.current));
      try {
        const response = await fetch('/api/compose/undo', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pendingId: record.id }),
          signal: AbortSignal.timeout(10_000),
        });
        const result = await response.json().catch(() => null);
        if (response.ok && result?.undone) {
          restore(record);
          return true;
        } else toast.error(result?.error || 'Could not cancel this send. Checking its status…');
      } catch {
        toast.error('Could not reach the server. Cancellation is not confirmed.');
      } finally {
        cancellingRef.current.delete(record.id);
        setCancelling(new Set(cancellingRef.current));
        void reconcile();
      }
      return false;
    },
    [reconcile, restore],
  );

  const cancelPendingSend = useCallback(
    async (id: string) => {
      const record = recordsRef.current.get(id);
      if (record) {
        const cancelled = await undo(record);
        if (!cancelled && recordsRef.current.has(id)) {
          recordsRef.current.set(id, { ...record, status: 'unknown' });
          publish();
        }
        return cancelled;
      }
      return removed.current.has(id);
    },
    [undo, publish],
  );
  const value = useMemo(
    () => ({ registerPendingSend, cancelPendingSend }),
    [registerPendingSend, cancelPendingSend],
  );
  return (
    <PendingSendContext.Provider value={value}>
      {children}
      {records.length > 0 &&
        createPortal(
          <div className="pointer-events-none fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 left-4 z-[10000] ml-auto flex max-h-[calc(100dvh-2rem)] w-auto max-w-[24rem] flex-col gap-2 overflow-y-auto sm:left-auto sm:w-96">
            {records.map((record) => (
              <PendingSendToast
                key={record.id}
                record={record}
                now={now}
                cancelling={cancelling.has(record.id)}
                onUndo={() => void undo(record)}
                onRestore={() => restore(record)}
              />
            ))}
          </div>,
          document.body,
        )}
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
    transaction.oncomplete = () => {
      database.close();
      resolve(request.result);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

let writes: Promise<unknown> = Promise.resolve();
function saveRecord(record: DurablePendingSend) {
  writes = writes.catch(() => undefined).then(() => withStore('readwrite', (store) => store.put(record)));
  return writes;
}

function deleteRecord(id: string) {
  writes = writes.catch(() => undefined).then(() => withStore('readwrite', (store) => store.delete(id)));
  return writes;
}

function loadRecords() {
  return withStore<DurablePendingSend[]>('readonly', (store) => store.getAll());
}

async function deleteServerDraft(id: string) {
  await callTool('delete_draft', { id }).catch(() => undefined);
}

/** Real compose + pending-send UI. Every API response is synthetic; no mail leaves this fixture. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { PendingSendProvider, usePendingSend } from '../../components/compose/PendingSendProvider';
import { InlineComposer } from '../../components/thread/InlineComposer';
import { useClientStore } from '../../lib/client-state';

const params = new URLSearchParams(location.search);
const seconds = Number(params.get('seconds') || 10);
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const receipts = new Map();
let statusOverride = sessionStorage.getItem('send-preview-status') || '';
let undoFails = false;
let statusCalls = 0;
let undoCalls = 0;
let effectCount = 0;
new MutationObserver((entries) => {
  for (const entry of entries)
    for (const node of entry.addedNodes)
      if (node instanceof HTMLElement && node.hasAttribute('data-send-celebration')) effectCount++;
}).observe(document.body, { childList: true });

globalThis.fetch = (async (input, init) => {
  const path = new URL(String(input), location.origin).pathname;
  if (path === '/api/prefs') return Response.json({ ok: true, prefs: { undoSendSeconds: seconds } });
  if (path === '/api/compose') {
    const form = init?.body as FormData;
    if (form.has('sendAt'))
      return Response.json({ ok: true, scheduled: { sendAt: Number(form.get('sendAt')) } });
    const undoSeconds = Number(form.get('undoSeconds') || 0);
    if (!undoSeconds) return Response.json({ ok: true, sent: { account: 'sender@example.test' } });
    const receipt = {
      id: String(form.get('pendingId') || crypto.randomUUID()),
      fireAt: Date.now() + undoSeconds * 1_000,
      undoSeconds,
    };
    receipts.set(receipt.id, receipt);
    if (params.has('delay')) await new Promise((resolve) => setTimeout(resolve, Number(params.get('delay'))));
    return Response.json({ ok: true, pending: receipt });
  }
  if (path === '/api/compose/undo') {
    undoCalls++;
    if (undoFails) throw new Error('Offline');
    const { pendingId } = JSON.parse(String(init?.body));
    const record = receipts.get(pendingId);
    if (record) record.cancelled = true;
    return Response.json({ ok: true, undone: true });
  }
  if (path === '/api/compose/status') {
    statusCalls++;
    if (statusOverride === 'offline') throw new Error('Offline');
    if (statusOverride === 'error') return Response.json({ ok: false }, { status: 503 });
    const id = new URL(String(input), location.origin).searchParams.get('pendingId');
    const receipt = receipts.get(id);
    return Response.json({
      ok: true,
      status:
        statusOverride ||
        (receipt?.cancelled ? 'cancelled' : receipt && receipt.fireAt > Date.now() ? 'pending' : 'sent'),
    });
  }
  if (path.endsWith('list_accounts'))
    return Response.json({
      ok: true,
      result: {
        accounts: [{ accountId: 'sender@example.test', email: 'sender@example.test', authed: true }],
      },
    });
  if (path.endsWith('save_draft')) return Response.json({ ok: true, result: { draft: { id: 'draft-1' } } });
  return Response.json({ ok: true, result: {}, enabled: false });
}) as typeof fetch;

function Fixture() {
  const compose = useClientStore((state) => state.compose);
  const { registerPendingSend } = usePendingSend();
  (window as any).sendPreview = {
    configure: (status: string, failUndo = false) => {
      statusOverride = status;
      undoFails = failUndo;
    },
    counts: () => ({ statusCalls, undoCalls, effectCount }),
    state: () => useClientStore.getState(),
    register: (id: string, duration: number, mode = 'new') =>
      registerPendingSend(
        { id, fireAt: Date.now() + duration * 1_000, undoSeconds: duration },
        {
          mode: mode as any,
          account: 'other@example.test',
          to: 'alex@example.test',
          cc: 'cc@example.test',
          bcc: 'bcc@example.test',
          subject: id,
          body: 'Keep this draft',
          files: [new File(['attachment'], 'notes.txt')],
          ...(mode !== 'new' ? { threadId: 'thread-1', anchorMessageId: 'message-1' } : {}),
        },
      ),
  };
  return (
    <main className="min-h-screen bg-[var(--color-bg)] p-8 text-[var(--color-text)]">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-2 text-xl font-semibold">Albatross</h1>
        <p className="mb-8 text-sm text-[var(--color-text-muted)]">Sending preview · synthetic mail</p>
        <button
          className="mb-4 rounded-lg border px-3 py-2"
          type="button"
          onClick={() =>
            useClientStore.getState().openComposeNew({
              to: 'alex@example.test',
              subject: 'The launch is ready',
              body: 'Let’s make it happen.',
            })
          }
        >
          New message
        </button>
        {compose.mode && (
          <InlineComposer
            key={compose.nonce}
            mode={compose.mode}
            account={compose.anchorAccount || 'sender@example.test'}
            threadId={compose.anchorThreadId}
            anchorMessageId={compose.anchorMessageId}
            initialPrefill={compose.prefill || undefined}
            onSent={() => useClientStore.getState().closeCompose()}
          />
        )}
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <PendingSendProvider>
      <Fixture />
      <Toaster position="bottom-center" />
    </PendingSendProvider>
  </QueryClientProvider>,
);

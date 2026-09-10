/** Actual AppShell + AIBar; all transport is deterministic and synthetic. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { createRoot } from 'react-dom/client';
import { AppShell } from '../../components/shell/AppShell';
import { useClientStore } from '../../lib/client-state';

const calls: string[] = [];
let agentStream: ReadableStreamDefaultController<Uint8Array> | null = null;
const encodeEvent = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const account = {
  accountId: 'fixture',
  email: 'alex@example.test',
  displayName: 'Personal',
  provider: 'google',
  authed: true,
  primary: true,
};
const items = Array.from({ length: 40 }, (_, index) => ({
  _id: `thread-${index}`,
  account: 'fixture',
  from: index % 2 ? 'Alex Morgan' : 'Studio North',
  subject: index % 2 ? 'Coffee tomorrow?' : 'A clearer place to work',
  snippet: 'Notes, decisions, and the next useful step.',
  unread: index < 4,
  date: Date.now() - index * 3_600_000,
  messageCount: 1,
}));
(window as any).workspacePreview = {
  calls,
  state: () => useClientStore.getState(),
  emitAgent: (event: unknown) => agentStream?.enqueue(encodeEvent(event)),
  finishAgent: () => {
    agentStream?.enqueue(encodeEvent({ type: 'text-end', id: 'synthetic-text' }));
    agentStream?.enqueue(encodeEvent({ type: 'finish', finishReason: 'stop' }));
    agentStream?.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    agentStream?.close();
    agentStream = null;
  },
};
globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input), location.origin);
  calls.push(`${init?.method || 'GET'} ${url.pathname}`);
  if (url.pathname === '/api/agent') {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          agentStream = controller;
          controller.enqueue(encodeEvent({ type: 'start', messageId: 'synthetic-assistant' }));
          controller.enqueue(encodeEvent({ type: 'text-start', id: 'synthetic-text' }));
          controller.enqueue(
            encodeEvent({ type: 'text-delta', id: 'synthetic-text', delta: 'The draft stays here.' }),
          );
        },
        cancel() {
          agentStream = null;
        },
      }),
      { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } },
    );
  }
  if (url.pathname === '/api/tools/list_accounts')
    return Response.json({ ok: true, result: { accounts: [account] } });
  if (/\/api\/tools\/(search_threads|list_smart_category)$/.test(url.pathname))
    return Response.json({ ok: true, result: { items } });
  if (url.pathname === '/api/tools/list_smart_labels')
    return Response.json({ ok: true, result: { custom: [] } });
  if (url.pathname === '/api/nylas/status') return Response.json({ accounts: [account] });
  if (url.pathname === '/api/chats') return Response.json({ sessions: [] });
  if (url.pathname === '/api/agent/uploads')
    return Response.json({
      ok: true,
      uploads: [{ uploadId: 'attachment-1', name: 'notes.txt', contentType: 'text/plain', size: 5 }],
    });
  if (url.pathname === '/api/albatross/route') return Response.json({ ok: true, route: 'ask' });
  if (url.pathname === '/api/files/status')
    return Response.json({
      ok: true,
      connections: [],
      providers: [],
      icloud: { mode: 'device_folder', detail: 'Synthetic fixture' },
    });
  if (url.pathname === '/api/files' || url.pathname === '/api/documents')
    return Response.json({ ok: true, files: [], documents: [], items: [] });
  if (url.pathname === '/api/office') return Response.json({ ok: true, enabled: false, files: [] });
  if (url.pathname === '/api/documents/fixture-document' && (!init?.method || init.method === 'GET'))
    return Response.json({
      ok: true,
      document: {
        documentId: 'fixture-document',
        kind: 'doc',
        title: 'Synthetic plan',
        currentRevision: 2,
        model: {
          kind: 'doc',
          version: 1,
          blocks: [
            { id: 'p1', type: 'paragraph', text: 'A synthetic working document beside the conversation.' },
          ],
        },
        sourceRefs: [],
        createdAt: 1,
        updatedAt: 2,
        suggestions: [],
      },
    });
  return Response.json(
    { ok: false, error: `Synthetic fixture does not implement ${url.pathname}` },
    { status: 404 },
  );
}) as typeof fetch;
useClientStore.setState({
  primaryView: 'mail',
  account: 'fixture',
  primaryAccount: 'fixture',
  railOpen: true,
  aiBarOpen: false,
  assistantPresentation: 'corner',
  lastChatId: null,
  lastChatAt: null,
});
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')!).render(
  <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
    <QueryClientProvider client={client}>
      <AppShell clerkEnabled={false} />
    </QueryClientProvider>
  </ThemeProvider>,
);

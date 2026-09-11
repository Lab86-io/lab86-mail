/** Actual AppShell + AIBar; all transport is deterministic and synthetic. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { createRoot } from 'react-dom/client';
import { CalendarProvider } from '../../components/calendar/engine/calendar-context';
import { CalendarHeader } from '../../components/calendar/engine/calendar-header';
import { NarrativeProse } from '../../components/narrative/NarrativeProse';
import { FrameGallery } from '../../components/report/brief-canvas/FrameGallery';
import { AppShell } from '../../components/shell/AppShell';
import { useClientStore } from '../../lib/client-state';
import {
  previewFiles,
  previewNarrative,
  previewQueryResults,
  previewReport,
  previewWeather,
  previewWorkspace,
} from './app-preview-data';
import { previewBriefResponseEvents } from './preview-brief-response';

(globalThis as any).__appPreviewQueryResults = previewQueryResults;

const calls: string[] = (window as any).workspacePreview?.calls ?? [];
const requests: Array<{ path: string; body: unknown }> = (window as any).workspacePreview?.requests ?? [];
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
  requests,
  manualAgent: (window as any).workspacePreview?.manualAgent ?? false,
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
    const body = JSON.parse(String(init?.body || '{}'));
    requests.push({ path: url.pathname, body });
    const demoBrief = body.briefResponse && !(window as any).workspacePreview.manualAgent;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          agentStream = controller;
          controller.enqueue(encodeEvent({ type: 'start', messageId: 'synthetic-assistant' }));
          controller.enqueue(encodeEvent({ type: 'text-start', id: 'synthetic-text' }));
          controller.enqueue(
            encodeEvent({
              type: 'text-delta',
              id: 'synthetic-text',
              delta: demoBrief
                ? 'Here is a sample reply and proposal for local review.'
                : 'The draft stays here.',
            }),
          );
          if (demoBrief)
            setTimeout(() => {
              if (agentStream !== controller) return;
              for (const event of previewBriefResponseEvents()) controller.enqueue(encodeEvent(event));
              controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
              controller.close();
              agentStream = null;
            }, 600);
        },
        cancel() {
          agentStream = null;
        },
      }),
      { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } },
    );
  }
  if (url.pathname === '/api/tools/get_latest_daily_report' || url.pathname === '/api/tools/get_daily_report')
    return Response.json({ ok: true, result: { report: previewReport } });
  if (url.pathname === '/api/tools/list_daily_reports')
    return Response.json({ ok: true, result: { reports: [previewReport] } });
  if (url.pathname.includes('daily_report_task_dismissals'))
    return Response.json({ ok: true, result: { cardIds: [] } });
  if (url.pathname.includes('daily_report_thread_dismissals'))
    return Response.json({ ok: true, result: { threadIds: [] } });
  if (url.pathname === '/api/narrative') return Response.json(previewNarrative);
  if (url.pathname === '/api/narrative/workspace') return Response.json(previewWorkspace);
  if (url.pathname === '/api/brief/weather') return Response.json(previewWeather);
  if (url.pathname === '/api/tools/get_thread') {
    const payload = JSON.parse(String(init?.body || '{}'));
    const row = items.find((item) => item._id === payload.threadId) || items[0];
    return Response.json({
      ok: true,
      result: {
        threadId: row._id,
        subject: row.subject,
        messages: [
          {
            id: 'message-1',
            from: [{ name: row.from, email: 'maya@example.test' }],
            to: [{ email: account.email }],
            subject: row.subject,
            body: '<p>Hi Alex,</p><p>The revised studio schedule is ready. Could you look at the photography dates before our planning conversation?</p><p>Thanks,<br>Maya</p><p><small>Fictional message for local review.</small></p>',
            date: row.date,
            unread: false,
          },
        ],
        labels: [],
      },
    });
  }
  if (url.pathname === '/api/calendar/resync') {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return Response.json({ ok: true, accounts: [] });
  }
  if (url.pathname === '/api/tools/list_accounts')
    return Response.json({ ok: true, result: { accounts: [account] } });
  if (/\/api\/tools\/(search_threads|list_smart_category)$/.test(url.pathname))
    return Response.json({ ok: true, result: { items } });
  if (url.pathname === '/api/tools/list_smart_labels')
    return Response.json({ ok: true, result: { custom: [] } });
  if (url.pathname === '/api/nylas/status') return Response.json({ accounts: [account] });
  if (url.pathname === '/api/chats') {
    if (init?.method === 'POST')
      requests.push({ path: url.pathname, body: JSON.parse(String(init.body || '{}')) });
    return Response.json({ sessions: [] });
  }
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
  if (url.pathname === '/api/files/library') {
    const search = (url.searchParams.get('search') || '').toLowerCase();
    return Response.json({
      ok: true,
      items:
        url.searchParams.get('kind') === 'documents'
          ? previewFiles.filter((item) => item.name.toLowerCase().includes(search))
          : [],
      nextCursor: null,
    });
  }
  if (url.pathname === '/api/office') return Response.json({ ok: true, enabled: false, files: [] });
  const previewFile = previewFiles.find((item) => url.pathname === `/api/documents/${item.documentId}`);
  if (previewFile && (!init?.method || init.method === 'GET'))
    return Response.json({
      ok: true,
      document: {
        documentId: previewFile.documentId,
        kind: 'doc',
        title: previewFile.name,
        currentRevision: 1,
        model: {
          kind: 'doc',
          version: 1,
          blocks: [
            { id: 'intro', type: 'paragraph', text: 'Fictional working document for this local preview.' },
            {
              id: 'body',
              type: 'paragraph',
              text:
                previewFile.name === 'North House proposal'
                  ? 'The studio proposal brings the launch photography, site updates, and opening event into one schedule. Review the photography dates with Maya before Friday.'
                  : 'Keep the schedule, useful notes, and remaining questions together. This sample contains no real account information.',
            },
          ],
        },
        sourceRefs: [],
        createdAt: previewFile.modifiedAt,
        updatedAt: previewFile.modifiedAt,
        suggestions: [],
      },
    });
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
if (!(window as any).__previewInitialized)
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
(window as any).__previewInitialized = true;
(window as any).__previewQueryClient ??= new QueryClient({ defaultOptions: { queries: { retry: false } } });
const client = (window as any).__previewQueryClient;
(window as any).__previewRoot ??= createRoot(document.getElementById('root')!);
const previewRoot = (window as any).__previewRoot;
previewRoot.render(
  <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
    <QueryClientProvider client={client}>
      {new URLSearchParams(location.search).get('review') === 'frames' ? (
        <FrameGallery />
      ) : new URLSearchParams(location.search).get('review') === 'controls' ? (
        <main className="min-h-screen bg-[var(--color-bg)] p-4 font-display text-[var(--color-text)]">
          <CalendarProvider users={[]} events={[]}>
            <CalendarHeader />
          </CalendarProvider>
          <article className="mx-auto mt-12 max-w-2xl">
            <NarrativeProse
              text={
                'Review the studio proposal before tomorrow’s planning meeting.\n\nThe team has shared the updated schedule and the remaining questions. A review is still needed before the release date can be confirmed.\n\nKeep the open questions together so they are easy to revisit in the meeting.'
              }
            />
          </article>
        </main>
      ) : (
        <AppShell clerkEnabled={false} userName="Alex Morgan" />
      )}
    </QueryClientProvider>
  </ThemeProvider>,
);

// @ts-expect-error Bun provides this only in its HTML development bundler.
if (import.meta.hot) import.meta.hot.accept();

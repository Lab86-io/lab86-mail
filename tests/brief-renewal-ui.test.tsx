import { afterEach, expect, spyOn, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import * as canvas from '../components/report/brief-canvas/BriefCanvas';
import { requestBriefEdition, useBriefEditionRequest } from '../components/report/brief-edition-request';
import { DailyReport } from '../components/report/DailyReport';
import * as client from '../lib/api-client';
import { BRIEF_NEW_EDITION_NOTE, BRIEF_PLAIN_LETTER_NOTE } from '../lib/brief/generation';
import { BRIEF_LETTER_FAILED_COPY } from '../lib/brief/letter';
import type { BriefPendingEdition, BriefViewResponse } from '../lib/brief/web-view';
import * as viewClient from '../lib/brief/web-view-client';
import { editorialFixture } from './fixtures/editorial';

const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function edition(id: string, patch: Record<string, unknown> = {}) {
  const { edition: base } = editorialFixture();
  return {
    ...base,
    _id: id,
    generatedAt: Date.now() - 60_000,
    artifactSource: 'document-v2',
    artifactStatus: 'ready',
    document: { version: 2, regions: [] },
    ...patch,
  } as any;
}

function plainLetter(id: string) {
  return edition(id, { document: undefined, artifactSource: 'deterministic', artifactStatus: 'composing' });
}

const viewOf = (report: unknown, pending: BriefPendingEdition | null = null, stamp = 'idle') =>
  ({ report, pending, stamp, revision: `rev-${(report as any)?._id ?? 'none'}` }) as BriefViewResponse;

interface Harness {
  view: BriefViewResponse | (() => Promise<BriefViewResponse>);
  head: { stamp: string; pending: BriefPendingEdition | null };
}

// A real page over stubbed reads. The canvas stub counts its mounts, so a test
// can prove that a swap keeps the scroll container.
async function mount(
  harness: Harness,
  options: { seed?: BriefViewResponse | null; embedded?: boolean; tools?: Record<string, unknown> } = {},
) {
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (options.seed !== null) query.setQueryData(['daily-report', 'latest'], options.seed ?? harness.view);
  query.setQueryData(['daily-report', 'head'], harness.head);
  const viewSpy = spyOn(viewClient, 'fetchBriefView').mockImplementation(async () =>
    typeof harness.view === 'function' ? harness.view() : harness.view,
  );
  const headSpy = spyOn(viewClient, 'fetchBriefHead').mockImplementation(async () => harness.head);
  const tool = spyOn(client, 'callTool').mockImplementation((async (name: string) => {
    if (options.tools && name in options.tools) {
      const value = options.tools[name];
      return typeof value === 'function' ? value() : value;
    }
    return { reports: [], cardIds: [], dismissals: [], health: { sources: [] }, work: [] };
  }) as any);
  let mounts = 0;
  const shown: Array<{ value: unknown; reportId: unknown; below: unknown; footer: unknown }> = [];
  const renderer = spyOn(canvas, 'BriefCanvas').mockImplementation((props: any) => {
    useEffect(() => {
      mounts += 1;
    }, []);
    shown.push({
      value: props.value,
      reportId: props.reportId,
      below: props.belowMasthead,
      footer: props.footer,
    });
    return (
      <div>
        <p>{`Edition ${props.reportId}`}</p>
        {props.belowMasthead}
        {props.footer}
      </div>
    );
  });
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  let view: ReactTestRenderer | undefined;
  await act(async () => {
    view = create(
      <QueryClientProvider client={query}>
        <DailyReport embedded={options.embedded ?? true} />
      </QueryClientProvider>,
    );
    await flush();
  });
  cleanups.push(async () => {
    if (view) await act(async () => view!.unmount());
    query.clear();
    viewSpy.mockRestore();
    headSpy.mockRestore();
    tool.mockRestore();
    renderer.mockRestore();
    errors.mockRestore();
  });
  return {
    query,
    viewSpy,
    headSpy,
    tool,
    text: () => JSON.stringify(view!.toJSON()),
    root: () => view!.root,
    mounts: () => mounts,
    shown,
    refresh: async () => {
      await act(async () => {
        await query.invalidateQueries({ queryKey: ['daily-report'] });
        await flush();
      });
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  // Newest first: a mount cleans up before the window stub of its test goes away.
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  requestBriefEdition(null);
});

test('during a partial row the last edition stays, with one quiet line and no vortex', async () => {
  const pending: BriefPendingEdition = { reportId: 'new', phase: 'writing' };
  const page = await mount({
    view: viewOf(edition('last-ready'), pending, 'new|partial||'),
    head: { stamp: 'new|partial||', pending },
  });
  expect(page.text()).toContain('Edition last-ready');
  expect(page.text()).toContain(BRIEF_NEW_EDITION_NOTE);
  expect(page.text()).not.toContain('Composing your brief');
  expect(page.root().findAll((node) => node.props['data-brief-new-edition'] === 'on-the-way')).toHaveLength(
    1,
  );
});

test('during composing the page shows the plain letter of the new edition', async () => {
  const pending: BriefPendingEdition = { reportId: 'new', phase: 'composing' };
  const page = await mount({
    view: viewOf(plainLetter('new'), pending, 'new|ready|composing|'),
    head: { stamp: 'new|ready|composing|', pending },
  });
  expect(page.text()).toContain('Edition new');
  expect(page.text()).toContain(BRIEF_PLAIN_LETTER_NOTE);
  expect(page.text()).not.toContain('Composing your brief');
  // Not a failure: the full edition is on the way.
  expect(page.text()).not.toContain(BRIEF_LETTER_FAILED_COPY);
  expect((page.shown.at(-1)?.value as any).regions.length).toBeGreaterThan(0);
});

test('the vortex shows only with nothing to read', async () => {
  const pending: BriefPendingEdition = {
    reportId: 'new',
    phase: 'writing',
    progress: { stage: 'Reading mail', done: 2, total: 5 },
  };
  const page = await mount({
    view: viewOf(null, pending, 'new|partial||'),
    head: { stamp: 'new|partial||', pending },
  });
  expect(page.text()).toContain('Composing your brief');
  expect(page.text()).toContain('Reading mail');
  expect(page.text()).toContain('2 of 5');
});

test('the swap keeps one canvas, so the reader keeps the scroll position', async () => {
  const pending: BriefPendingEdition = { reportId: 'new', phase: 'writing' };
  const harness: Harness = {
    view: viewOf(edition('last-ready'), pending, 'new|partial||'),
    head: { stamp: 'new|partial||', pending },
  };
  const page = await mount(harness);
  expect(page.mounts()).toBe(1);

  const composing: BriefPendingEdition = { reportId: 'new', phase: 'composing' };
  harness.view = viewOf(plainLetter('new'), composing, 'new|ready|composing|');
  harness.head = { stamp: 'new|ready|composing|', pending: composing };
  await page.refresh();
  expect(page.text()).toContain('Edition new');
  expect(page.text()).toContain(BRIEF_PLAIN_LETTER_NOTE);
  expect(page.mounts()).toBe(1);

  harness.view = viewOf(edition('new'), null, 'idle');
  harness.head = { stamp: 'idle', pending: null };
  await page.refresh();
  expect(page.text()).not.toContain(BRIEF_PLAIN_LETTER_NOTE);
  expect(page.text()).not.toContain(BRIEF_NEW_EDITION_NOTE);
  expect(page.mounts()).toBe(1);
  expect(page.shown.at(-1)?.value).toEqual({ version: 2, regions: [] });
});

test('when the head moves past the view, the page reads the edition again', async () => {
  const pending: BriefPendingEdition = { reportId: 'new', phase: 'writing' };
  const harness: Harness = {
    view: viewOf(edition('last-ready'), null, 'idle'),
    head: { stamp: 'idle', pending: null },
  };
  const page = await mount(harness);
  page.viewSpy.mockClear();
  harness.view = viewOf(edition('last-ready'), pending, 'new|partial||');
  harness.head = { stamp: 'new|partial||', pending };
  await act(async () => {
    await flush(1);
    await page.query.refetchQueries({ queryKey: ['daily-report', 'head'], exact: true });
    await flush(5);
  });
  expect(page.viewSpy).toHaveBeenCalled();
  expect(page.text()).toContain(BRIEF_NEW_EDITION_NOTE);
});

test('an unchanged read keeps the edition on the page and sends the known revision', async () => {
  const harness: Harness = {
    view: viewOf(edition('kept'), null, 'idle'),
    head: { stamp: 'idle', pending: null },
  };
  const page = await mount(harness);
  page.viewSpy.mockClear();
  harness.view = { stamp: 'idle', pending: null, revision: 'rev-kept', unchanged: true };
  await page.refresh();
  expect(page.viewSpy.mock.calls.at(-1)?.[0]).toEqual({ known: 'rev-kept' });
  expect(page.text()).toContain('Edition kept');
});

test('a click on Write follows the same rule and stays busy until the page knows the job', async () => {
  const harness: Harness = {
    view: viewOf(edition('last-ready'), null, 'idle'),
    head: { stamp: 'idle', pending: null },
  };
  let finish!: (value: unknown) => void;
  const page = await mount(harness, {
    tools: {
      generate_daily_report: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  const writer = () =>
    page
      .root()
      .findAllByType('button')
      .find(
        (button) => String(button.props.children).includes('again') || button.props.children === 'Writing…',
      )!;
  await act(async () => {
    writer().props.onClick();
    await flush();
  });
  expect(writer().props.disabled).toBe(true);
  expect(page.text()).toContain('Edition last-ready');
  expect(page.text()).not.toContain('Composing your brief');

  const pending: BriefPendingEdition = { reportId: 'new', phase: 'writing' };
  harness.view = viewOf(edition('last-ready'), pending, 'new|partial||');
  harness.head = { stamp: 'new|partial||', pending };
  await act(async () => {
    finish({ report: { _id: 'new', status: 'partial' }, started: true });
    await flush(5);
  });
  expect(writer().props.disabled).toBe(true);
  expect(page.text()).toContain(BRIEF_NEW_EDITION_NOTE);

  harness.view = viewOf(edition('new'), null, 'idle');
  harness.head = { stamp: 'idle', pending: null };
  await page.refresh();
  expect(writer().props.disabled).toBe(false);
  expect(page.text()).toContain('Edition new');
  expect(page.text()).not.toContain(BRIEF_NEW_EDITION_NOTE);
});

test('a first Write with nothing to read shows the vortex, and a failed Write goes back', async () => {
  let fail!: (error: Error) => void;
  const harness: Harness = { view: viewOf(null), head: { stamp: 'idle', pending: null } };
  const page = await mount(harness, {
    tools: {
      generate_daily_report: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    },
  });
  expect(page.text()).not.toContain('Composing your brief');
  const writer = () =>
    page
      .root()
      .findAllByType('button')
      .find(
        (button) => String(button.props.children).includes('Write') || button.props.children === 'Writing…',
      )!;
  await act(async () => {
    writer().props.onClick();
    await flush();
  });
  expect(page.text()).toContain('Composing your brief');
  await act(async () => {
    fail(new Error('offline'));
    await flush(5);
  });
  expect(page.text()).not.toContain('Composing your brief');
  expect(writer().props.disabled).toBe(false);
});

test('a plain letter with no job says it failed and offers to write again', async () => {
  const page = await mount({
    view: viewOf(
      edition('plain', { document: undefined, artifactSource: 'deterministic', artifactStatus: 'rendered' }),
    ),
    head: { stamp: 'idle', pending: null },
  });
  expect(page.text()).toContain(BRIEF_LETTER_FAILED_COPY);
  expect(page.text()).toContain('Write it again');
});

test('a failed first read offers a retry, and a saved edition survives a failed read', async () => {
  const page = await mount(
    { view: () => Promise.reject(new Error('offline')), head: { stamp: 'idle', pending: null } },
    { seed: null },
  );
  await act(async () => {
    await flush(5);
  });
  expect(page.text()).toContain('Your brief couldn’t load');

  const saved = await mount(
    { view: () => Promise.reject(new Error('offline')), head: { stamp: 'idle', pending: null } },
    { seed: viewOf(edition('saved')) },
  );
  expect(saved.text()).toContain('Edition saved');
});

test('the retry note shows on a readable edition, and the reader keeps reading', async () => {
  const page = await mount({
    view: viewOf(edition('fallback', { retrying: true })),
    head: { stamp: 'fallback|ready|ready|retry', pending: null },
  });
  expect(page.text()).toContain('The writer could not finish this edition');
  expect(page.text()).toContain('Edition fallback');
});

test('the task and thread dismissal reads wait for an older page that needs them', async () => {
  const page = await mount({ view: viewOf(edition('letter')), head: { stamp: 'idle', pending: null } });
  const names = page.tool.mock.calls.map(([name]) => name);
  expect(names).not.toContain('list_daily_report_task_dismissals');
  expect(names).not.toContain('list_daily_report_thread_dismissals');
  expect(names).not.toContain('list_daily_reports');
});

// The menu's cleanup reads `window`.
function withWindow() {
  const target = globalThis as { window?: unknown };
  const had = 'window' in target;
  target.window = globalThis;
  cleanups.push(async () => {
    if (!had) delete target.window;
  });
}

test('history loads on open, hides the edition in writing, and picks a past edition', async () => {
  withWindow();
  const pending: BriefPendingEdition = { reportId: 'new', phase: 'writing' };
  const page = await mount(
    {
      view: viewOf(edition('last-ready'), pending, 'new|partial||'),
      head: { stamp: 'new|partial||', pending },
    },
    {
      embedded: false,
      tools: {
        list_daily_reports: {
          reports: [
            { _id: 'new', kind: 'manual', generatedAt: 3 },
            { _id: 'last-ready', kind: 'morning', generatedAt: 2 },
            { _id: 'older', kind: 'morning', generatedAt: 1 },
          ],
        },
      },
    },
  );
  expect(page.tool.mock.calls.some(([name]) => name === 'list_daily_reports')).toBe(false);
  const select = () => page.root().findByProps({ 'aria-label': 'Browse past editions' });
  expect(select()).toBeTruthy();
  const root = page
    .root()
    .findAll((node) => typeof node.props.onOpenChange === 'function' && node.props.value === 'latest')[0];
  await act(async () => {
    root.props.onOpenChange(true);
    await flush(1);
  });
  const calls = page.tool.mock.calls.filter(([name]) => name === 'list_daily_reports');
  expect(calls).toHaveLength(1);
  expect(calls[0][1]).toEqual({ limit: 30, summaryOnly: true });
  const items = page.query.getQueryData<any>(['daily-report', 'history']).reports;
  expect(items).toHaveLength(3);
  expect(page.text()).not.toContain('Past editions did not load');

  await act(async () => {
    root.props.onValueChange('older');
    await flush(1);
  });
  expect(page.viewSpy.mock.calls.some(([body]) => body.id === 'older')).toBe(true);
  expect(
    page.query
      .getQueryCache()
      .find({ queryKey: ['daily-report', 'older'] })
      ?.isActive(),
  ).toBe(true);
});

test('a first edition has no menu of past editions', async () => {
  withWindow();
  const page = await mount(
    { view: viewOf(edition('first', { first: true })), head: { stamp: 'idle', pending: null } },
    { embedded: false },
  );
  expect(page.root().findAll((node) => node.props['aria-label'] === 'Browse past editions')).toHaveLength(0);
});

test('a notification waits for one fresh read and keeps the newest edition live', async () => {
  const fresh = edition('new');
  const harness: Harness = { view: viewOf(fresh), head: { stamp: 'idle', pending: null } };
  let finishHistory!: (value: any) => void;
  requestBriefEdition('new');
  const page = await mount(harness, {
    seed: viewOf(edition('previous')),
    tools: {
      list_daily_reports: () =>
        new Promise((resolve) => {
          finishHistory = resolve;
        }),
    },
  });
  expect(useBriefEditionRequest.getState().reportId).toBe('new');
  expect(page.tool.mock.calls.find(([name]) => name === 'list_daily_reports')?.[1]).toEqual({
    limit: 1,
    summaryOnly: true,
  });
  await act(async () => {
    finishHistory({ reports: [{ _id: 'new', generatedAt: fresh.generatedAt }] });
    await flush(5);
  });
  expect(useBriefEditionRequest.getState().reportId).toBeNull();
  expect(page.query.getQueryData<any>(['daily-report', 'latest']).report._id).toBe('new');
  expect(page.viewSpy.mock.calls.some(([body]) => body.id === 'new')).toBe(false);

  page.viewSpy.mockClear();
  await act(async () => {
    requestBriefEdition('old');
  });
  await act(async () => {
    finishHistory({ reports: [{ _id: 'new', generatedAt: fresh.generatedAt }] });
    await flush(5);
  });
  expect(page.viewSpy.mock.calls.some(([body]) => body.id === 'old')).toBe(true);
  expect(
    page.query
      .getQueryCache()
      .find({ queryKey: ['daily-report', 'old'] })
      ?.isActive(),
  ).toBe(true);
});

test('a notification for the edition on the page stays live while a newer row is written', async () => {
  const pending: BriefPendingEdition = { reportId: 'writing-row', phase: 'writing' };
  const harness: Harness = {
    view: viewOf(edition('shown'), pending, 'writing-row|partial||'),
    head: { stamp: 'writing-row|partial||', pending },
  };
  requestBriefEdition('shown');
  const page = await mount(harness, {
    tools: { list_daily_reports: { reports: [{ _id: 'writing-row', generatedAt: 9 }] } },
  });
  await act(async () => {
    await flush(5);
  });
  expect(useBriefEditionRequest.getState().reportId).toBeNull();
  expect(page.viewSpy.mock.calls.some(([body]) => body.id === 'shown')).toBe(false);
});

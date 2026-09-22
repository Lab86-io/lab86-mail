import { expect, spyOn, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import * as canvas from '../components/report/brief-canvas/BriefCanvas';
import { requestBriefEdition, useBriefEditionRequest } from '../components/report/brief-edition-request';
import { DailyReport } from '../components/report/DailyReport';
import * as client from '../lib/api-client';
import { editorialFixture } from './fixtures/editorial';

test('notification selection waits for fresh history and keeps the newest edition live', async () => {
  const { edition } = editorialFixture();
  const report = {
    ...edition,
    _id: 'new',
    generatedAt: Date.now(),
    artifactSource: 'document-v2',
    artifactStatus: 'ready',
    document: { version: 2, regions: [] },
  };
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  query.setQueryData(['daily-report', 'latest'], { report: { ...report, _id: 'previous' } });
  query.setQueryData(['daily-report', 'history'], { reports: [{ _id: 'old', generatedAt: 1 }] });
  query.setQueryData(['daily-report', 'task-dismissals'], { cardIds: [] });
  query.setQueryData(['daily-report', 'thread-dismissals'], { dismissals: [] });
  let finishHistory!: (value: any) => void;
  const request = spyOn(client, 'callTool').mockImplementation((async (name: string) => {
    if (name === 'list_daily_reports')
      return new Promise((resolve) => {
        finishHistory = resolve;
      });
    if (name === 'get_latest_daily_report') return { report };
    if (name === 'get_daily_report') return { report: { ...report, _id: 'old' } };
    return { reports: [], cardIds: [], dismissals: [] };
  }) as any);
  let live = false;
  const renderer = spyOn(canvas, 'BriefCanvas').mockImplementation((props) => {
    live = props.liveSections === true;
    return <p>Edition</p>;
  });
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  let view: ReactTestRenderer | undefined;
  try {
    requestBriefEdition('new');
    await act(async () => {
      view = create(
        <QueryClientProvider client={query}>
          <DailyReport embedded />
        </QueryClientProvider>,
      );
    });
    expect(useBriefEditionRequest.getState().reportId).toBe('new');
    expect(request.mock.calls.some(([name]) => name === 'get_daily_report')).toBe(false);
    await act(async () => {
      finishHistory({
        reports: [
          { _id: 'new', generatedAt: report.generatedAt },
          { _id: 'old', generatedAt: 1 },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(useBriefEditionRequest.getState().reportId).toBeNull();
    expect(live).toBe(true);
    expect(query.getQueryData<any>(['daily-report', 'latest']).report._id).toBe('new');
    expect(request.mock.calls.some(([name]) => name === 'get_daily_report')).toBe(false);

    await act(async () => {
      requestBriefEdition('old');
    });
    await act(async () => {
      finishHistory({
        reports: [
          { _id: 'new', generatedAt: report.generatedAt },
          { _id: 'old', generatedAt: 1 },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      request.mock.calls.some(([name, args]) => name === 'get_daily_report' && (args as any).id === 'old'),
    ).toBe(true);
    expect(
      query
        .getQueryCache()
        .find({ queryKey: ['daily-report', 'old'] })
        ?.isActive(),
    ).toBe(true);
  } finally {
    if (view) await act(async () => view!.unmount());
    requestBriefEdition(null);
    query.clear();
    request.mockRestore();
    renderer.mockRestore();
    errors.mockRestore();
  }
});

test('renewal immediately shows generation and displays the replacement when it settles', async () => {
  const { edition } = editorialFixture();
  let report = {
    ...edition,
    generatedAt: Date.now() - 60_000,
    artifactSource: 'document-v2',
    artifactStatus: 'ready',
    document: { version: 2, regions: [] },
  };
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  query.setQueryData(['daily-report', 'latest'], { report });
  query.setQueryData(['daily-report', 'history'], { reports: [] });
  query.setQueryData(['daily-report', 'task-dismissals'], { cardIds: [] });
  query.setQueryData(['daily-report', 'thread-dismissals'], { dismissals: [] });
  let finish!: (value: any) => void;
  const request = spyOn(client, 'callTool').mockImplementation((async (name: string) => {
    if (name === 'generate_daily_report')
      return new Promise((resolve) => {
        finish = resolve;
      });
    if (name === 'get_latest_daily_report') return { report };
    return { reports: [], cardIds: [], dismissals: [] };
  }) as any);
  const renderer = spyOn(canvas, 'BriefCanvas').mockImplementation(() => (
    <p>Saved editorial remains readable.</p>
  ));
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      view = create(
        <QueryClientProvider client={query}>
          <DailyReport embedded />
        </QueryClientProvider>,
      );
    });
    const refresh = () =>
      view!.root
        .findAllByType('button')
        .find(
          (button) => String(button.props.children).includes('again') || button.props.children === 'Writing…',
        )!;
    await act(async () => {
      refresh().props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(refresh().props.disabled).toBe(true);
    expect(JSON.stringify(view!.toJSON())).toContain('Composing your brief');
    expect(JSON.stringify(view!.toJSON())).not.toContain('Saved editorial remains readable.');
    await act(async () => {
      report = { ...report, generatedAt: Date.now() };
      finish({ report });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(refresh().props.disabled).toBe(false);
    expect(JSON.stringify(view!.toJSON())).toContain('Saved editorial remains readable.');
  } finally {
    if (view) await act(async () => view!.unmount());
    query.clear();
    request.mockRestore();
    renderer.mockRestore();
    errors.mockRestore();
  }
});

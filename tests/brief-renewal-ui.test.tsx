import { expect, spyOn, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import * as canvas from '../components/report/brief-canvas/BriefCanvas';
import { DailyReport } from '../components/report/DailyReport';
import * as client from '../lib/api-client';
import { editorialFixture } from './fixtures/editorial';

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

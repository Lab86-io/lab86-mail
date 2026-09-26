import { afterEach, expect, spyOn, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import * as canvas from '../components/report/brief-canvas/BriefCanvas';
import { DailyReport } from '../components/report/DailyReport';
import * as client from '../lib/api-client';
import type { BriefSourceHealthSummary } from '../lib/brief/source-health';

/*
 * The latest edition in the older HTML format renders in its own frame. The
 * source line (source health) and the note that the edition describes an
 * older day show above the frame, as they do under the letter's masthead.
 */

const DAY = 24 * 3_600_000;
const HEALTH: BriefSourceHealthSummary = {
  sources: [
    {
      id: 'mail:acct',
      kind: 'mail',
      label: 'ann@example.com',
      status: 'reconnect',
      lastSyncedAt: null,
      inEdition: true,
      detail: 'ann@example.com needs to be connected again.',
      reconnectPath: '/settings?tab=mailboxes',
    },
  ],
  attention: 1,
  line: 'One source needs you.',
  checkedAt: 0,
} as unknown as BriefSourceHealthSummary;

function legacyReport(generatedAt: number) {
  return {
    _id: 'legacy',
    generatedAt,
    kind: 'daily',
    status: 'ready',
    artifactSource: 'ai',
    html: '<!doctype html><html><body><h1>The Wednesday Brief</h1></body></html>',
    narrative: '',
    sections: {},
    stats: {},
  };
}

function render(report: Record<string, unknown> & { generatedAt: number }, selectedHistory = false) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  query.setQueryData(['daily-report', 'latest'], { report });
  query.setQueryData(['daily-report', 'history'], {
    reports: selectedHistory ? [{ _id: 'legacy', generatedAt: report.generatedAt }] : [],
  });
  query.setQueryData(['daily-report', 'task-dismissals'], { cardIds: [] });
  query.setQueryData(['daily-report', 'thread-dismissals'], { dismissals: [] });
  query.setQueryData(['brief-sources', 'legacy'], HEALTH);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={query}>
      <DailyReport />
    </QueryClientProvider>,
  );
  return new JSDOM(html).window.document;
}

const request = spyOn(client, 'callTool').mockImplementation((async () => ({})) as any);
afterEach(() => request.mockClear());

test('an old HTML edition shows the source line and says it describes an older day', () => {
  const doc = render(legacyReport(Date.now() - 80 * DAY));
  const frame = doc.querySelector('iframe[title="The Daily Brief"]');
  expect(frame).not.toBeNull();
  const line = doc.querySelector('[data-brief-source-line]');
  expect(line).not.toBeNull();
  expect(doc.querySelector('[data-brief-source-problem="reconnect"]')?.textContent).toContain(
    'needs to be connected again',
  );
  const stale = doc.querySelector('[data-brief-stale-note]');
  expect(stale?.textContent).toBe('Written 80 days ago — it describes an older day.');
  // Both sit above the frame, not inside it.
  const strip = stale?.parentElement;
  expect(strip?.contains(frame as Node)).toBe(false);
  expect(strip?.compareDocumentPosition(frame as Node)).toBe(
    doc.defaultView!.Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

test('a current HTML edition shows the source line without the stale note', () => {
  const doc = render(legacyReport(Date.now() - 2 * 3_600_000));
  expect(doc.querySelector('[data-brief-source-line]')).not.toBeNull();
  expect(doc.querySelector('[data-brief-stale-note]')).toBeNull();
});

test('the letter says it describes an older day with its source line too', () => {
  const renderer = spyOn(canvas, 'BriefCanvas').mockImplementation((props) => (
    <div>{props.belowMasthead}</div>
  ));
  try {
    const doc = render({
      ...legacyReport(Date.now() - 3 * DAY),
      html: undefined,
      artifactSource: 'document-v2',
      artifactStatus: 'ready',
      document: { version: 2, regions: [] },
    });
    expect(doc.querySelector('[data-brief-stale-note]')?.textContent).toBe(
      'Written 3 days ago — it describes an older day.',
    );
    expect(doc.querySelector('[data-brief-source-line]')).not.toBeNull();
  } finally {
    renderer.mockRestore();
  }
});

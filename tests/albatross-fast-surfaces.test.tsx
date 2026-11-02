import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { ThreadListPlaceholder } from '../components/albatross/AlbatrossesSurface';
import { showsThreadRows, THREAD_LIST_HOLD_MS } from '../components/albatross/ThreadListKeeper';
import {
  LIVE_ROWS_OPEN,
  LiveRunRows,
  RunLiveText,
  ThreadLoading,
} from '../components/albatross/thread/RunLive';
import { threadNeedsNoSeenWrite } from '../lib/albatross/threads';
import { needsYouBadge, railWorkBadge } from '../lib/albatross/work-state';
import { withPlanArtifact } from '../lib/albatross/work-view';
import { newestDocumentAnswer } from '../lib/documents/revision-order';

const read = (path: string) => readFileSync(path, 'utf8');

describe('the live rows of a run', () => {
  const rows = [
    { at: Date.UTC(2026, 9, 7, 14, 0), text: 'Searched your mail.' },
    { at: Date.UTC(2026, 9, 7, 14, 1), text: 'Reads irs.gov.' },
  ];

  test('only the newest row moves and speaks to a screen reader', () => {
    const doc = new JSDOM(renderToStaticMarkup(<LiveRunRows rows={rows} shimmerNewest timeZone="UTC" />))
      .window.document;
    const newest = doc.querySelector('[data-slot="run-live-row-newest"]')!;
    expect(newest.textContent).toContain('Reads irs.gov.');
    expect(newest.getAttribute('aria-live')).toBe('polite');
    const older = doc.querySelector('[data-slot="run-live-row"]')!;
    expect(older.textContent).toContain('Searched your mail.');
    expect(older.getAttribute('aria-live')).toBeNull();
    expect(older.querySelector('time')?.textContent).toContain('2:00');
  });

  test('with a live line above, the newest row does not shimmer', () => {
    const still = renderToStaticMarkup(<LiveRunRows rows={rows} shimmerNewest={false} timeZone="UTC" />);
    const moving = renderToStaticMarkup(<LiveRunRows rows={rows} shimmerNewest timeZone="UTC" />);
    expect(still).not.toContain('bg-clip-text');
    expect(moving).toContain('bg-clip-text');
  });

  test('the clock of the newest row shows after five seconds and writes nothing', () => {
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <LiveRunRows rows={[{ at: Date.now() - 42_000, text: 'Reads a page.' }]} shimmerNewest />,
      );
    });
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain('run-row-clock');
    expect(text).toMatch(/4[0-9]/);
    act(() => renderer!.unmount());
    const fresh = renderToStaticMarkup(
      <LiveRunRows rows={[{ at: Date.now(), text: 'Reads a page.' }]} shimmerNewest />,
    );
    expect(fresh).not.toContain('run-row-clock');
  });

  test('three rows stay open', () => {
    expect(LIVE_ROWS_OPEN).toBe(3);
  });

  test('the live text uses the type of a run message, so nothing moves when the message comes', () => {
    const html = renderToStaticMarkup(<RunLiveText text="The June invoice was number 11" />);
    expect(html).toContain('data-slot="run-live-text"');
    // The words come through the same metered reveal as a chat reply.
    expect(html).toContain('chat-reveal');
    expect(html).toContain('text-[13.5px]');
  });
});

describe('the frames that show at once', () => {
  test('the thread shows its title from the list while its detail loads', () => {
    const doc = new JSDOM(renderToStaticMarkup(<ThreadLoading title="Renew the car" label="Loading" />))
      .window.document;
    const section = doc.querySelector('[data-slot="thread-loading"]')!;
    expect(section.getAttribute('aria-busy')).toBe('true');
    expect(section.getAttribute('aria-label')).toBe('Loading');
    expect(section.textContent).toContain('Renew the car');
  });

  test('with no row yet, the title is a quiet line', () => {
    const html = renderToStaticMarkup(<ThreadLoading label="Loading" />);
    expect(html).toContain('data-slot="skeleton"');
    expect(html).toContain('motion-reduce:animate-none');
  });

  test('the first load of the list holds the space of its rows and hides them from a screen reader', () => {
    const html = renderToStaticMarkup(<ThreadListPlaceholder />);
    expect(html).toContain('data-slot="thread-list-placeholder"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('motion-reduce:animate-none');
  });

  test('the list has no spinner, and keeps its frame while rows load', () => {
    const surface = read('components/albatross/AlbatrossesSurface.tsx');
    expect(surface).not.toContain('LoaderCircle');
    expect(surface).toContain('<ThreadListPlaceholder />');
    // The placeholder is hidden from a screen reader, so a status line says that rows come.
    expect(surface).toContain('role="status"');
    expect(surface).toContain('const loading = works === undefined || rows === undefined;');
  });

  test('the thread draws its rail before it waits for the detail', () => {
    const thread = read('components/albatross/WorkThread.tsx');
    const rail = thread.indexOf('const rail = showRail ?');
    const waits = thread.indexOf('if (detail === undefined)');
    expect(rail).toBeGreaterThan(-1);
    expect(rail).toBeLessThan(waits);
    expect(thread.slice(waits, waits + 300)).toContain('{rail}');
  });
});

describe('the subscriptions', () => {
  test('the rail holds the list queries, outside the sheet that closes on a phone', () => {
    const rail = read('components/shell/Rail.tsx');
    expect(rail.indexOf('<ThreadListKeeper />')).toBeLessThan(rail.indexOf('<Sidebar\n'));
    expect(rail).toContain('</Sidebar>\n    </>');
  });

  test('a failed read of the kept list stays out of the shell', () => {
    const rail = read('components/shell/Rail.tsx');
    expect(rail).toMatch(/<SurfaceErrorBoundary surface="The Albatross list" quiet>\s*<ThreadListKeeper \/>/);
  });

  test('a document read that started before a save does not replace the saved revision', () => {
    const answer = (currentRevision: number) => ({ document: { currentRevision } });
    const saved = answer(5);
    expect(newestDocumentAnswer(saved, answer(4))).toBe(saved);
    const next = answer(6);
    expect(newestDocumentAnswer(saved, next)).toBe(next);
    expect(newestDocumentAnswer(undefined, next)).toBe(next);
    expect(read('components/files/DocumentEditor.tsx')).toContain('newestDocumentAnswer(');
  });

  test('the live text of a run is a polite live region', () => {
    expect(read('components/albatross/thread/RunLive.tsx')).toContain(
      'data-slot="run-live-text" aria-live="polite"',
    );
  });

  test('the rail reads its small queries, not the overview and the Work list', () => {
    const rail = read('components/shell/Rail.tsx');
    expect(rail).toContain('api.albatross.railAreas');
    expect(rail).toContain('api.albatrossWorkV2.railNeedsYouCount');
    expect(rail).not.toContain('api.albatross.listAreasOverview');
    expect(rail).not.toContain('api.albatrossWorkV2.allWork');
  });

  test('the hold covers the surfaces with thread rows, and ends after a while', () => {
    expect(showsThreadRows('albatrosses')).toBe(true);
    expect(showsThreadRows('areas')).toBe(true);
    expect(showsThreadRows('mail')).toBe(false);
    expect(THREAD_LIST_HOLD_MS).toBe(600_000);
  });

  test('the thread asks for its detail without the page and reads the page only in Details', () => {
    const thread = read('components/albatross/WorkThread.tsx');
    expect(thread).toContain('omitPlanArtifact: true');
    expect(thread).toMatch(/region === 'details' && planId/);
  });

  test('the editor subscribes to the revision, and polls fast only with no live answer', () => {
    const editor = read('components/files/DocumentEditor.tsx');
    expect(editor).toContain('api.documents.savedRevision');
    // Fast with no live answer. Slow with one: a suggestion keeps the revision, and a socket can drop.
    expect(editor).toMatch(
      /liveRevision === null\s*\?\s*SAVED_REVISION_CHECK_MS\s*:\s*LIVE_REVISION_BACKSTOP_MS/,
    );
  });
});

describe('small rules', () => {
  test('a thread with nothing new writes no seen row', () => {
    expect(threadNeedsNoSeenWrite({ unread: false, seenAt: 5 })).toBe(true);
    expect(threadNeedsNoSeenWrite({ unread: true, seenAt: 5 })).toBe(false);
    expect(threadNeedsNoSeenWrite({ unread: false, seenAt: null })).toBe(false);
    expect(threadNeedsNoSeenWrite(null)).toBe(false);
    expect(threadNeedsNoSeenWrite(undefined)).toBe(false);
  });

  test('the badge words come from a count', () => {
    expect(needsYouBadge(0)).toBeNull();
    expect(needsYouBadge(1)).toBe('One needs you');
    expect(needsYouBadge(3)).toBe('3 need you');
    expect(railWorkBadge([{ openQuestions: 1 }, { openQuestions: 2 }])).toBe('2 need you');
  });

  test('the page joins the plan it belongs to, and no other', () => {
    const detail: { plan: Record<string, unknown>; other: number } = {
      plan: { _id: 'plan_1', outcome: 'Done' },
      other: 1,
    };
    expect(withPlanArtifact(detail, null)).toBe(detail);
    expect(withPlanArtifact(detail, { planId: 'plan_2', artifactHtml: '<p>x</p>' })).toBe(detail);
    expect(withPlanArtifact({ plan: null }, { planId: 'plan_1' })).toEqual({ plan: null });
    expect(
      withPlanArtifact(detail, { planId: 'plan_1', artifactHtml: '<p>x</p>', document: { regions: [] } }),
    ).toEqual({
      plan: { _id: 'plan_1', outcome: 'Done', artifactHtml: '<p>x</p>', document: { regions: [] } },
      other: 1,
    });
    expect(withPlanArtifact(detail, { planId: 'plan_1', artifactHtml: null, document: null })).toEqual({
      plan: detail.plan,
      other: 1,
    });
  });
});

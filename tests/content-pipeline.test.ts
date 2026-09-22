import { describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import JSZip from 'jszip';
import { syncCloudContent } from '../lib/content/cloud-sync';
import { extractContent } from '../lib/content/extract';
import { contentRoutes } from '../lib/content/http';
import { prepareBriefWork } from '../lib/content/prepare';
import { projectBriefMail } from '../lib/jev/report';
import { assessment, NOW, policy, report, thread } from './fixtures/jev';

describe('connected content sync', () => {
  function harness(provider = 'google_drive', cursor?: any, failure = 0) {
    const writes: any[] = [];
    const urls: string[] = [];
    const deps: any = {
      listCloudFileConnections: async () => [{ connectionId: 'drive', provider, status: 'connected' }],
      getCloudFileAccess: async () => ({ accessToken: 'synthetic-token', connection: { provider } }),
      convexMutation: async (ref: any, args: any) => {
        writes.push({ name: getFunctionName(ref), ...args });
        return getFunctionName(ref).endsWith(':claimSync')
          ? { lease: 'lease', cursor }
          : { changed: args.items?.length || 0, done: true, cursor: null };
      },
      convexQuery: async () => ({}),
      extractContent: async (bytes: Uint8Array) => ({
        text: new TextDecoder().decode(bytes),
        partial: false,
      }),
      fetch: async (url: string) => {
        urls.push(url);
        if (failure) return new Response('', { status: failure });
        if (url.includes('startPageToken')) return Response.json({ startPageToken: 'anchor' });
        if (url.includes('/changes?'))
          return Response.json({
            newStartPageToken: 'next',
            changes: [{ fileId: 'removed', removed: true }],
          });
        if (url.includes('/files?'))
          return Response.json({
            files: [
              {
                id: 'doc',
                name: 'Plan',
                mimeType: 'application/vnd.google-apps.document',
                version: '1',
                modifiedTime: '2026-09-21T12:00:00Z',
              },
            ],
          });
        if (url.includes('/delta'))
          return Response.json({
            value: [{ id: 'doc', name: 'Plan.txt', file: { mimeType: 'text/plain' }, eTag: '1' }],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=next',
          });
        return new Response('Approval is required.');
      },
    };
    return { deps, writes, urls };
  }
  test('anchors the initial Drive backfill, reads real body content, then continues from the change token', async () => {
    const { deps, writes, urls } = harness();
    await syncCloudContent('owner', deps);
    expect(urls[0]).toContain('startPageToken');
    expect(urls.some((u) => u.includes('/export?mimeType=text%2Fplain'))).toBe(true);
    expect(writes.find((w) => w.name.endsWith(':upsert')).items[0].text).toContain('Approval is required.');
    expect(writes.at(-1)).toMatchObject({
      cursor: { phase: 'reconcile', resume: { phase: 'changes', token: 'anchor' } },
      status: 'indexing',
    });
    const changes = harness('google_drive', { phase: 'changes', token: 'anchor' });
    await syncCloudContent('owner', changes.deps);
    expect(changes.writes.find((w) => w.items)?.items[0].deleted).toBe(true);
    expect(changes.writes.at(-1).cursor.token).toBe('next');
  });
  test('OneDrive keeps delta continuation; transient failures keep the old cursor; lost access closes visibility', async () => {
    const one = harness('onedrive');
    await syncCloudContent('owner', one.deps);
    expect(one.writes.at(-1).cursor.resume.url).toContain('token=next');
    const unavailable = harness('google_drive', { phase: 'changes', token: 'saved' }, 503);
    await syncCloudContent('owner', unavailable.deps);
    expect(unavailable.writes.at(-1)).toMatchObject({ cursor: { token: 'saved' }, status: 'error' });
    const denied = harness('google_drive', undefined, 403);
    await syncCloudContent('owner', denied.deps);
    expect(denied.writes.at(-1).status).toBe('access_lost');
    expect(denied.writes.some((w) => w.items)).toBe(false);
  });
  test('bounded metadata continuation marks a census only after every pending file is processed', async () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      id: `file${i}`,
      name: `file${i}.txt`,
      mimeType: 'text/plain',
      version: '1',
    }));
    const start = harness('google_drive', {
      generation: 'scan',
      pending: files,
      next: { phase: 'changes', token: 'anchor' },
    });
    await syncCloudContent('owner', start.deps);
    expect(start.writes.filter((w) => w.items).flatMap((w) => w.items)).toHaveLength(8);
    expect(start.writes.at(-1).cursor.pending).toHaveLength(2);
    const rest = harness('google_drive', start.writes.at(-1).cursor);
    await syncCloudContent('owner', rest.deps);
    expect(rest.writes.at(-1).cursor.phase).toBe('reconcile');
    const cleanup = harness('google_drive', rest.writes.at(-1).cursor);
    await syncCloudContent('owner', cleanup.deps);
    expect(cleanup.urls).toEqual([]);
    expect(cleanup.writes.at(-1)).toMatchObject({
      cursor: { phase: 'changes', token: 'anchor' },
      status: 'ready',
    });
  });
  test('expired change feeds restart a census and unchanged files avoid downloads', async () => {
    const expired = harness('google_drive', { phase: 'changes', token: 'old' }, 410);
    await syncCloudContent('owner', expired.deps);
    expect(expired.writes.at(-1).cursor).toBeNull();
    const first = harness();
    await syncCloudContent('owner', first.deps);
    const saved = first.writes.find((w) => w.items).items[0];
    const repeat = harness();
    repeat.deps.convexQuery = async () => ({ 'google_drive:drive:doc': saved.version });
    await syncCloudContent('owner', repeat.deps);
    expect(repeat.urls.some((url) => url.includes('/export'))).toBe(false);
    expect(repeat.writes.find((w) => w.name.endsWith(':reconcileScan')).keys).toEqual([
      'google_drive:drive:doc',
    ]);
  });
  test('Office extraction indexes content and leaves markup behind', async () => {
    const zip = new JSZip();
    zip.file(
      'word/document.xml',
      '<w:document><w:p><w:r><w:t>Approval requirement</w:t></w:r></w:p></w:document>',
    );
    const value = await extractContent(
      await zip.generateAsync({ type: 'uint8array' }),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'requirements.docx',
    );
    expect(value.text).toContain('Approval requirement');
    expect(value.text).not.toContain('<w:');
  });
});

test('Brief admits a new personal request intraday, excludes noise, and preserves the saved edition', () => {
  const saved = report([]);
  const initial = JSON.stringify(saved);
  const arrivals = [
    thread({ _id: 'request', lastDate: NOW + 1000, jev: assessment() }),
    thread({
      _id: 'sports',
      lastDate: NOW + 2000,
      jev: assessment({ purpose: 'promotion', obligations: [] }),
    }),
    thread({ _id: 'foreign', account: 'outside', lastDate: NOW + 1000, jev: assessment() }),
  ];
  const live = projectBriefMail(saved, arrivals, policy, NOW + 3000);
  expect(live.sections.answer?.map((i) => i.threadId)).toEqual(['request']);
  expect(JSON.stringify(saved)).toBe(initial);
  expect(projectBriefMail(saved, arrivals, policy, NOW + 25 * 3600_000)).toBe(saved);
});

test('preparation researches connected sources with a generative model and persists exact source versions', async () => {
  const seed: any = {
    _id: 'source1',
    title: 'Launch',
    text: 'Approval is required.',
    version: 'v1',
    source: 'document',
    modifiedAt: NOW,
    partial: false,
  };
  const calls: any[] = [];
  const writes: any[] = [];
  const draft = {
    title: 'Launch plan',
    shape: 'project',
    situation: 'Approval is needed.',
    background: 'The requirements require approval.',
    assessment: 'Collect it before launch.',
    recommendation: 'Review the draft.',
    questions: [],
    steps: ['Collect approval'],
    files: [{ name: 'plan.md', content: '# Plan\nCollect approval.' }],
    evidence: [{ sourceId: 'source1', quote: 'Approval is required.' }],
  };
  const result = await prepareBriefWork('owner', {
    convexMutation: async (ref: any, args: any) => {
      writes.push({ name: getFunctionName(ref), ...args });
      return getFunctionName(ref).endsWith(':claim')
        ? { _id: 'proposal', lease: 'lease', revision: 4, seed, userNotes: 'Use the current scope.' }
        : true;
    },
    convexQuery: async () => [seed],
    generateObjectForCurrentUser: async (args: any) => {
      calls.push(args);
      return {
        object: args.feature === 'brief_preparation_research' ? { queries: ['launch requirements'] } : draft,
      };
    },
    searchContent: async () => ({ items: [seed], semanticUnavailable: false }),
  } as any);
  expect(result.prepared).toBe(true);
  expect(calls.every((c) => c.speed === 'primary')).toBe(true);
  expect(calls[1].prompt).toContain('Use the current scope.');
  expect(writes.at(-1)).toMatchObject({
    revision: 4,
    seedVersion: 'v1',
    sources: [{ id: 'source1', version: 'v1' }],
  });
});

test('content HTTP routes bind the authenticated owner, reject injected ownership and cap bodies before parsing', async () => {
  const calls: any[] = [];
  const routes = contentRoutes({
    requireCurrentUser: async () => ({ userId: 'owner' }),
    enforceUserRateLimit: async () => {},
    convexQuery: async (_ref: any, args: any) => {
      calls.push(args);
      return {};
    },
    convexMutation: async () => {},
    kickContentCycle: () => {},
    searchContent: async () => ({ items: [], semanticUnavailable: false }),
  } as any);
  expect((await routes.GET(new Request('http://localhost/api/content?userId=foreign'))).status).toBe(200);
  expect(calls[0].userId).toBe('owner');
  expect(
    (
      await routes.POST(
        new Request('http://localhost/api/content', {
          method: 'POST',
          body: JSON.stringify({ operation: 'sync', userId: 'foreign' }),
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await routes.POST(
        new Request('http://localhost/api/content', { method: 'POST', body: 'x'.repeat(320_001) }),
      )
    ).status,
  ).toBe(413);
  expect((await routes.GET(new Request('http://localhost/api/content?view=search&q=a'))).status).toBe(400);
});

test('search merges indexed body matches with metadata without duplicates and keeps Files scoped to files', async () => {
  const { mergeSearchItems, isIndexedFile } = await import('../lib/search/global-search');
  const match: any = {
    id: 'content:doc',
    title: 'Plan',
    detail: 'Matching body',
    contentSource: 'document',
    target: { kind: 'document', documentId: 'doc' },
  };
  const metadata = { ...match, id: 'documents:other-row', detail: 'Metadata' };
  expect(mergeSearchItems([match], [metadata])).toEqual([match]);
  expect(isIndexedFile(match)).toBe(true);
  expect(isIndexedFile({ ...match, contentSource: 'jira' })).toBe(false);
});

test('interactive vector waits obey cancellation even when the remote action is still running', async () => {
  const { withAbort } = await import('../lib/content/intelligence');
  const controller = new AbortController();
  const result = withAbort(new Promise(() => {}), controller.signal);
  controller.abort(new Error('search deadline'));
  await expect(result).rejects.toThrow('search deadline');
});

import { expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { classifyContent, embedContent, searchContent } from '../lib/content/intelligence';
import { syncMailAttachments } from '../lib/content/mail-attachments';
import { syncMcpContent } from '../lib/content/mcp-sync';
import { runContentCycle } from '../lib/content/sync';
import { createContentSearch } from '../lib/tools/content';

const item: any = {
  _id: 'item',
  source: 'document',
  connectionId: 'library',
  externalId: 'doc',
  title: 'Launch',
  text: 'Jakob must prepare approval.',
  version: '1',
  modifiedAt: Date.now(),
  indexedAt: Date.now(),
  partial: false,
  ownerIdentities: ['Jakob'],
};
const answers: any = {
  kind: { type: 'choice', choice: 'request', confidence: 0.9 },
  work: { type: 'choice', choice: 'w0', confidence: 0.99 },
  actionable: { type: 'noul', noul: 0.95 },
  resolved: { type: 'noul', noul: 0.1 },
};

test('classification supplies trusted owner identity, validates answer types and requires confident work matching', async () => {
  const calls: any[] = [];
  const deps: any = {
    resolveClassifierRuntime: async () => ({ apiKey: 'fake' }),
    evaluateClassifier: async (args: any) => {
      calls.push(args);
      return { model: 'typesafe/jev-1.13', answers };
    },
    recordClassifierUsage: async () => {},
  };
  expect(await classifyContent('owner', item, [{ id: 'work', text: 'Launch' }], deps)).toMatchObject({
    actionable: true,
    resolved: false,
    workId: 'work',
  });
  expect(calls[0].state.ownerIdentities).toEqual(['Jakob']);
  deps.evaluateClassifier = async () => ({
    model: 'typesafe/jev-1.13',
    answers: {
      ...answers,
      kind: { ...answers.kind, choice: 'noise' },
      work: { ...answers.work, confidence: 0.4 },
    },
  });
  expect(await classifyContent('owner', item, [{ id: 'work', text: 'Launch' }], deps)).toMatchObject({
    actionable: false,
    workId: null,
  });
  deps.evaluateClassifier = async () => ({
    model: 'typesafe/jev-1.13',
    answers: { ...answers, actionable: { type: 'choice' } },
  });
  await expect(classifyContent('owner', item, [], deps)).rejects.toThrow('Invalid');
});

test('embedding parsing restores provider order, records usage and rejects malformed dimensions', async () => {
  const usage: any[] = [];
  const deps: any = {
    resolveOpenRouterUtilityRuntime: async () => ({ apiKey: 'fake' }),
    recordClassifierUsage: async (...args: any[]) => usage.push(args),
  };
  const fetcher: any = async (_url: string, args: any) => {
    expect(JSON.parse(args.body).dimensions).toBe(1536);
    return Response.json({
      data: [
        { index: 1, embedding: Array(1536).fill(0.2) },
        { index: 0, embedding: Array(1536).fill(0.1) },
      ],
      usage: { prompt_tokens: 20 },
    });
  };
  const result = await embedContent('owner', ['a', 'b'], undefined, fetcher, deps);
  expect(result.map((v) => v[0])).toEqual([0.1, 0.2]);
  expect(usage[0][2].usage.input_tokens).toBe(20);
  expect(await embedContent('owner', [], undefined, fetcher, deps)).toEqual([]);
  await expect(
    embedContent(
      'owner',
      ['a'],
      undefined,
      (async () => Response.json({ data: [{ index: 0, embedding: [1] }] })) as unknown as typeof fetch,
      deps,
    ),
  ).rejects.toThrow('Invalid');
  await expect(
    embedContent(
      'owner',
      ['a'],
      undefined,
      (async () => new Response('', { status: 503 })) as unknown as typeof fetch,
      deps,
    ),
  ).rejects.toThrow('unavailable');
});

test('semantic fusion retains exact matches, deduplicates overlapping hits, and falls back on provider failure', async () => {
  const related = { ...item, _id: 'semantic' };
  const deps: any = {
    convexQuery: async () => [item],
    embedContent: async () => [[0.1]],
    vectorSearch: async () => [related, item],
  };
  const result = await searchContent('owner', 'approval', {}, deps);
  expect(result.items.map((r) => r._id)).toEqual(['item', 'semantic']);
  deps.embedContent = async () => {
    throw new Error('provider unavailable');
  };
  expect(await searchContent('owner', 'approval', {}, deps)).toEqual({
    items: [item],
    semanticUnavailable: true,
  });
  expect(await searchContent('owner', 'approval', { semantic: false }, deps)).toEqual({
    items: [item],
    semanticUnavailable: false,
  });
});

test('attachment sync deduplicates metadata, downloads in the owner account, and retries transient failures', async () => {
  const writes: any[] = [];
  const reads: any[] = [];
  const file = {
    connectionId: 'mail',
    messageId: 'message',
    attachmentId: 'attachment',
    filename: 'approval.txt',
    mimeType: 'text/plain',
    size: undefined,
    modifiedAt: 1,
  };
  const deps: any = {
    convexQuery: async () => ({}),
    convexMutation: async (_ref: any, args: any) => writes.push(args),
    downloadNylasAttachment: async (args: any) => {
      reads.push(args);
      return new Response('Signed approval').body;
    },
    extractContent: async (bytes: Uint8Array) => ({ text: new TextDecoder().decode(bytes), partial: false }),
  };
  await syncMailAttachments(
    'owner',
    [file, file, { ...file, attachmentId: 'video', filename: 'video.mp4', mimeType: 'video/mp4' }],
    deps,
  );
  expect(reads).toEqual([
    { userId: 'owner', account: 'mail', messageId: 'message', attachmentId: 'attachment' },
  ]);
  expect(writes[0].items[0].text).toContain('Signed approval');
  expect(writes[1].items[0].partial).toBe(true);
  const saved = writes[0].items[0];
  deps.convexQuery = async () => ({ [`attachment:mail:${saved.externalId}`]: saved.version });
  await syncMailAttachments('owner', [file], deps);
  expect(reads).toHaveLength(1);
  deps.convexQuery = async () => ({});
  deps.downloadNylasAttachment = async () => {
    throw new Error('transient');
  };
  await syncMailAttachments('owner', [file], deps);
  expect(writes).toHaveLength(2);
  await syncMailAttachments('owner', [], deps);
});

function mcpHarness(server: string, canPage = true) {
  const calls: any[] = [];
  const writes: any[] = [];
  let closed = 0;
  const tool =
    server === 'slack' ? 'search_messages' : server === 'jira' ? 'searchJiraIssuesUsingJql' : 'list_meetings';
  const handle: any = {
    toolNames: new Set([tool, 'get_meetings']),
    toolSchemas: new Map([
      [tool, { properties: canPage ? { page: {}, startAt: {}, sort: {}, sort_dir: {} } : {} }],
      ['get_meetings', { properties: { meeting_ids: { type: 'array' } } }],
    ]),
    close: async () => {
      closed++;
    },
  };
  const deps: any = {
    listUserConnections: async () => [
      {
        connectionId: 'connected',
        server,
        status: 'connected',
        includeInSearch: true,
        includeInBrief: true,
        serverUrl: 'https://example.test',
      },
    ],
    getConnectionToken: async () => ({ token: 'fake' }),
    connectMcp: async () => handle,
    callMcpTool: async (_handle: any, name: string, args: any) => {
      calls.push({ name, args });
      return {
        structuredContent: [
          { id: 'one', title: 'Approval', text: 'Jakob needs approval', notes: 'The approver is Jane.' },
        ],
      };
    },
    convexMutation: async (ref: any, args: any) => {
      writes.push({ name: getFunctionName(ref), ...args });
      return {
        lease: 'lease',
        cursor: server === 'granola' ? null : { offset: server === 'slack' ? 2 : 100 },
      };
    },
  };
  return { deps, calls, writes, closed: () => closed };
}

test('connected tools page only with advertised parameters and explicitly report limited provider coverage', async () => {
  for (const server of ['slack', 'jira', 'granola']) {
    const h = mcpHarness(server);
    await syncMcpContent('owner', h.deps);
    expect(h.closed()).toBe(1);
    expect(h.writes.some((w) => w.name === 'mcp:upsertItems')).toBe(true);
    expect(h.writes.at(-1).status).toBe(server === 'granola' ? 'provider_limited' : 'indexing');
    if (server === 'slack') expect(h.calls.map((c) => c.args.page)).toEqual([1, 2]);
    if (server === 'jira') expect(h.calls.map((c) => c.args.startAt)).toEqual([0, 100]);
    if (server === 'granola') expect(h.calls[1].args.meeting_ids).toEqual(['one']);
  }
  const limited = mcpHarness('slack', false);
  await syncMcpContent('owner', limited.deps);
  expect(limited.calls[0].args.page).toBeUndefined();
  expect(limited.writes.at(-1).status).toBe('provider_limited');
  const failed = mcpHarness('slack');
  failed.deps.callMcpTool = async () => {
    throw new Error('provider');
  };
  await syncMcpContent('owner', failed.deps);
  expect(failed.writes.at(-1).status).toBe('error');
  expect(failed.closed()).toBe(1);
});

test('content cycle independently commits successful classifications when embeddings fail and still prepares work', async () => {
  const writes: any[] = [];
  let preparations = 0;
  let classified = 0;
  const deps: any = {
    convexMutation: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      writes.push({ name, ...args });
      return name.endsWith(':claimSync')
        ? { lease: 'lease' }
        : name.endsWith(':claimItems')
          ? [
              { ...item, lease: 'a' },
              { ...item, _id: 'cached', lease: 'b', labels: { kind: 'request' }, embeddingVersion: '1' },
            ]
          : { changed: args.items?.length || 0 };
    },
    convexQuery: async (ref: any, args: any) => {
      if (getFunctionName(ref).endsWith(':workCandidates')) return [];
      if (args.source === 'mcp') throw new Error('temporary source failure');
      return {
        items: [{ ...item, source: args.source }],
        cursor: args.recent ? null : 'next',
        attachments: [],
      };
    },
    syncCloudContent: async () => {},
    syncMailAttachments: async () => {},
    syncMcpContent: async () => {},
    loadJevPolicy: async () => ({ preferences: { enabled: true } }),
    classifyContent: async () => {
      classified++;
      return { kind: 'request' };
    },
    embedContent: async () => {
      throw new Error('embedding outage');
    },
    prepareBriefWork: async () => {
      preparations++;
    },
  };
  expect(await runContentCycle('owner', deps)).toEqual({ started: true, processed: 2 });
  expect(classified).toBe(1);
  expect(preparations).toBe(1);
  expect(writes.find((w) => w.name.endsWith(':completeItem'))).toMatchObject({
    labels: { kind: 'request' },
    vectors: undefined,
  });
  expect(writes.find((w) => w.name.endsWith(':finishSync') && w.connectionId === '__mcp').status).toBe(
    'error',
  );
  expect(writes.at(-1).connectionId).toBe('__cycle');
  deps.convexMutation = async () => null;
  expect(await runContentCycle('owner', deps)).toEqual({ started: false });
});

test('agent content search requires identity and returns bounded excerpts with exact provenance', async () => {
  const tool = createContentSearch(async () => ({
    items: [{ ...item, text: 'x'.repeat(9000) + ' Signed approval required.' }],
    semanticUnavailable: false,
  }));
  await expect(tool.handler({ query: 'approval', semantic: true }, { agent: 'ai' })).rejects.toThrow(
    'authenticated',
  );
  const result = await tool.handler({ query: 'approval', semantic: true }, { agent: 'ai', userId: 'owner' });
  expect(result.items[0].content).toContain('Signed approval');
  expect(result.items[0].partial).toBe(true);
  expect(result.items[0].url).toBe('/?view=files&document=doc');
});

test('native search translates indexed sources into openable results and preserves partial coverage notices', async () => {
  const { searchIndexedContent } = await import('../lib/search/global-search');
  const result = await searchIndexedContent('approval', true, undefined, (async () =>
    Response.json({
      items: [
        item,
        { ...item, _id: 'mail', source: 'mail' },
        {
          ...item,
          _id: 'cloud',
          source: 'google_drive',
          connectionId: 'drive',
          externalId: 'file',
          url: 'https://drive.google.com/file/d/file',
          partial: true,
        },
      ],
      semanticUnavailable: true,
    })) as any);
  expect(result.items).toHaveLength(2);
  expect(result.items[0].target).toEqual({ kind: 'document', documentId: 'doc' });
  expect(result.items[1].id).toBe('cloud:drive:file');
  expect(result.items[1].detail).toContain('Partial content');
  expect(result.warnings).toHaveLength(1);
  await expect(
    searchIndexedContent(
      'approval',
      false,
      undefined,
      (async () => new Response('', { status: 503 })) as any,
    ),
  ).rejects.toThrow('could not');
  await expect(
    searchIndexedContent('approval', false, undefined, (async () => Response.json({})) as any),
  ).rejects.toThrow('incomplete');
});

test('permanent attachment failures become partial records and stop starving later files', async () => {
  const versions: Record<string, string> = {};
  const writes: any[] = [];
  const files = Array.from({ length: 9 }, (_, i) => ({
    connectionId: 'mail',
    messageId: 'message',
    attachmentId: String(i),
    filename: `${i}.pdf`,
    mimeType: 'application/pdf',
    size: 20,
    modifiedAt: 1,
  }));
  const deps: any = {
    convexQuery: async () => versions,
    convexMutation: async (_ref: any, args: any) => {
      for (const item of args.items) {
        writes.push(item);
        versions[`attachment:mail:${item.externalId}`] = item.version;
      }
    },
    downloadNylasAttachment: async ({ attachmentId }: any) => {
      if (attachmentId === '0') return null;
      if (attachmentId === '1') throw Object.assign(new Error('gone'), { statusCode: 404 });
      return new Response(attachmentId).body;
    },
    extractContent: async (bytes: Uint8Array) => {
      if (new TextDecoder().decode(bytes) !== '8')
        throw Object.assign(new Error('Malformed PDF'), { name: 'InvalidPDFException' });
      return { text: 'Useful final file', partial: false };
    },
  };
  await syncMailAttachments('owner', files, deps);
  expect(writes).toHaveLength(8);
  expect(writes.every((w) => w.partial)).toBe(true);
  await syncMailAttachments('owner', files, deps);
  expect(writes).toHaveLength(9);
  expect(writes[8].text).toContain('Useful final file');
  expect(writes[8].partial).toBe(false);
});

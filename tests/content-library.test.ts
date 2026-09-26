import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import { safeDeltaUrl } from '../lib/content/cloud-sync';
import {
  contentChunks,
  contentExcerpt,
  preparedDraftSchema,
  researchExcerpt,
  sourceLink,
  validatePreparedEvidence,
} from '../lib/content/contract';
import { boundedBytes, extractContent, MAX_DOWNLOAD_BYTES } from '../lib/content/extract';
import { contentQuestions } from '../lib/content/intelligence';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/content.ts': () => import('../convex/content'),
  '../convex/briefPreparations.ts': () => import('../convex/briefPreparations'),
};
const scope = { internalSecret: 'content-tests', userId: 'owner' };
let previous: string | undefined;
beforeAll(() => {
  previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = scope.internalSecret;
});
afterAll(() => {
  if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
});
const content = (api as any).content;
const preparations = (api as any).briefPreparations;
test('content census advances bounded connected pages across ticks and wraps without starving later users', async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (let i = 0; i < 55; i++)
      await ctx.db.insert('cloudFileConnections', {
        userId: `user-${i}`,
        connectionId: `drive-${i}`,
        provider: 'google_drive',
        accountKey: String(i),
        scopes: [],
        status: i < 53 ? 'connected' : 'disconnected',
        createdAt: 1,
        updatedAt: 1,
      });
  });
  const first = await t.mutation((internal as any).content.users, { source: 'cloudFileConnections' });
  const second = await t.mutation((internal as any).content.users, { source: 'cloudFileConnections' });
  expect(first).toHaveLength(50);
  expect(second).toHaveLength(3);
  expect(new Set([...first, ...second]).size).toBe(53);
  expect([...first, ...second]).not.toContain('user-53');
  expect(await t.mutation((internal as any).content.users, { source: 'cloudFileConnections' })).toEqual(
    first,
  );
  expect(await t.mutation((internal as any).content.users, { source: 'connectedAccounts' })).toEqual([]);
  expect(await t.mutation((internal as any).content.users, { source: 'mcpConnections' })).toEqual([]);
});
const labels = {
  kind: 'request',
  actionable: true,
  resolved: false,
  workId: null,
  confidence: 0.98,
  model: 'typesafe/jev-1.13',
  evaluatedAt: Date.now(),
};
function source(version = '1', userId = 'owner') {
  return {
    source: 'google_drive',
    connectionId: 'drive',
    externalId: `${userId}-file`,
    title: 'Launch requirements',
    text: 'Please prepare the launch plan. The release requires signed approval.',
    version,
    modifiedAt: Date.now(),
    partial: false,
  };
}
async function seed(t: ReturnType<typeof convexTest>, userId = 'owner') {
  await t.run((ctx) =>
    ctx.db.insert('cloudFileConnections', {
      userId,
      connectionId: 'drive',
      provider: 'google_drive',
      accountKey: userId,
      scopes: [],
      status: 'connected',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await t.mutation(content.upsert, { ...scope, userId, items: [source('1', userId)] });
  return (await t.mutation(content.claimItems, { ...scope, userId }))[0];
}
async function classify(t: ReturnType<typeof convexTest>, row: any) {
  return t.mutation(content.completeItem, {
    ...scope,
    id: row._id,
    version: row.version,
    lease: row.lease,
    labels,
    vectors: [Array(1536).fill(0.01)],
  });
}
function draft(id: string, overrides: Record<string, unknown> = {}) {
  return {
    title: 'Prepare launch',
    shape: 'project',
    situation: 'Launch needs approval.',
    background: 'The requirements name signed approval.',
    assessment: 'Approval is still needed.',
    recommendation: 'Review the attached plan.',
    questions: [],
    steps: ['Collect approval', 'Schedule launch'],
    files: [{ name: 'launch-plan.md', content: '# Launch plan\nObtain signed approval.' }],
    evidence: [{ sourceId: id, quote: 'The release requires signed approval.' }],
    ...overrides,
  };
}
async function prepare(t: ReturnType<typeof convexTest>, row: any, overrides: Record<string, unknown> = {}) {
  await classify(t, row);
  const claim = await t.mutation(preparations.claim, scope);
  expect(claim).toBeTruthy();
  await t.mutation(preparations.complete, {
    ...scope,
    id: claim._id,
    lease: claim.lease,
    revision: claim.revision,
    seedVersion: row.version,
    draft: draft(row._id, overrides),
    sources: [{ id: row._id, version: row.version }],
  });
  return (await t.query(preparations.list, scope))[0];
}
describe('content library and durable Brief preparations', () => {
  test('isolates owners, indexes text before classification, honors disconnects', async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await seed(t, 'foreign');
    await expect(
      t.query(content.search, { ...scope, internalSecret: 'wrong', query: 'approval' }),
    ).rejects.toThrow();
    expect(await t.query(content.search, { ...scope, query: 'approval' })).toHaveLength(1);
    await t.run(async (ctx) => {
      const connection = await ctx.db
        .query('cloudFileConnections')
        .withIndex('by_user_connection', (q) => q.eq('userId', 'owner').eq('connectionId', 'drive'))
        .unique();
      await ctx.db.patch(connection!._id, { status: 'disconnected' });
    });
    expect(await t.query(content.search, { ...scope, query: 'approval' })).toEqual([]);
  });
  test('idempotent writes preserve accepted classification; changed and deleted versions clear vectors', async () => {
    const t = convexTest(schema, modules);
    const row = await seed(t);
    await classify(t, row);
    expect((await t.mutation(content.upsert, { ...scope, items: [source()] })).changed).toBe(0);
    expect((await t.query(content.search, { ...scope, query: 'approval' }))[0].labels.kind).toBe('request');
    await t.mutation(content.upsert, { ...scope, items: [source('2')] });
    expect(await classify(t, row)).toBe(false);
    expect(await t.run((ctx) => ctx.db.query('contentChunks').collect())).toEqual([]);
    await t.mutation(content.upsert, { ...scope, items: [{ ...source('3'), deleted: true }] });
    expect(await t.query(content.search, { ...scope, query: 'approval' })).toEqual([]);
  });
  test('leases prevent duplicate background work and preferences pause new work', async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(content.claimSync, { ...scope, connectionId: 'drive' });
    expect(first.lease).toBeTruthy();
    expect(await t.mutation(content.claimSync, { ...scope, connectionId: 'drive' })).toBeNull();
    expect(
      await t.mutation(content.finishSync, {
        ...scope,
        connectionId: 'drive',
        lease: 'wrong',
        indexed: 0,
        skipped: 0,
        status: 'ready',
      }),
    ).toBe(false);
    await t.mutation(content.savePreferences, { ...scope, enabled: false, prepare: true });
    expect(await t.mutation(content.claimSync, { ...scope, connectionId: 'new' })).toBeNull();
    expect(await t.mutation(preparations.claim, scope)).toBeNull();
  });
  test('preparation creates no work or library files until atomic idempotent adoption', async () => {
    const t = convexTest(schema, modules);
    const sourceRow = await seed(t);
    const item = await prepare(t, sourceRow);
    expect(await t.run((ctx) => ctx.db.query('albatrossIntents').collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query('documents').collect())).toEqual([]);
    await t.mutation(preparations.update, {
      ...scope,
      id: item._id,
      revision: item.revision,
      operation: 'edit',
      files: [{ name: 'launch-plan.md', content: 'My edited plan' }],
    });
    await expect(
      t.mutation(preparations.update, {
        ...scope,
        id: item._id,
        revision: item.revision,
        operation: 'adopt',
      }),
    ).rejects.toThrow('PREPARATION_CONFLICT');
    const adopted = await t.mutation(preparations.update, {
      ...scope,
      id: item._id,
      revision: item.revision + 1,
      operation: 'adopt',
    });
    const repeated = await t.mutation(preparations.update, {
      ...scope,
      id: item._id,
      revision: item.revision + 1,
      operation: 'adopt',
    });
    expect(repeated.workId).toBe(adopted.workId);
    const work = await t.run((ctx) => ctx.db.get(adopted.workId));
    expect(work.shape).toBe('project');
    expect(work.rawText).toContain('Approval is still needed');
    const docs = await t.run((ctx) => ctx.db.query('documents').collect());
    expect(docs).toHaveLength(1);
    expect(docs[0].model.blocks[0].text).toBe('My edited plan');
    expect(await t.query(preparations.list, scope)).toEqual([]);
  });
  test('adopting a preparation with open questions asks them as pending Work questions', async () => {
    const t = convexTest(schema, modules);
    const sourceRow = await seed(t);
    const item = await prepare(t, sourceRow, {
      questions: ['Who signs the approval?', 'Which launch date holds?'],
    });
    const adopted = await t.mutation(preparations.update, {
      ...scope,
      id: item._id,
      revision: item.revision,
      operation: 'adopt',
    });
    const work = await t.run((ctx) => ctx.db.get(adopted.workId));
    expect(work).toMatchObject({ status: 'needs_answers', agentState: 'needs_input' });
    const questions = await t.run((ctx) => ctx.db.query('albatrossWorkQuestions').collect());
    expect(
      questions.map((question) => ({
        workId: question.workId,
        legacyQuestionId: question.legacyQuestionId,
        prompt: question.prompt,
        status: question.status,
      })),
    ).toEqual([
      {
        workId: adopted.workId,
        legacyQuestionId: 'prepared_0',
        prompt: 'Who signs the approval?',
        status: 'pending',
      },
      {
        workId: adopted.workId,
        legacyQuestionId: 'prepared_1',
        prompt: 'Which launch date holds?',
        status: 'pending',
      },
    ]);
    expect(new Set(questions.map((question) => question.dedupeKey)).size).toBe(2);
  });
  test('dismissed suggestions do not reappear; stale model writes and fabricated citations are rejected', async () => {
    const t = convexTest(schema, modules);
    const row = await seed(t);
    await classify(t, row);
    const claim = await t.mutation(preparations.claim, scope);
    await expect(
      t.mutation(preparations.complete, {
        ...scope,
        id: claim._id,
        lease: claim.lease,
        revision: claim.revision,
        seedVersion: '1',
        draft: { ...draft(row._id), evidence: [{ sourceId: row._id, quote: 'Fabricated requirement' }] },
        sources: [{ id: row._id, version: '1' }],
      }),
    ).rejects.toThrow();
    await t.mutation(content.upsert, { ...scope, items: [source('2')] });
    expect(
      await t.mutation(preparations.complete, {
        ...scope,
        id: claim._id,
        lease: claim.lease,
        revision: claim.revision,
        seedVersion: '1',
        draft: draft(row._id),
        sources: [{ id: row._id, version: '1' }],
      }),
    ).toBe(false);
    await t.mutation(preparations.update, { ...scope, id: claim._id, revision: 1, operation: 'dismiss' });
    const [next] = await t.mutation(content.claimItems, scope);
    await classify(t, next);
    expect(await t.mutation(preparations.claim, scope)).toBeNull();
  });
});

test('chunk overlap, typed classification and evidence validation preserve retrieval boundaries', () => {
  const chunks = contentChunks('x'.repeat(8000));
  expect(chunks).toHaveLength(3);
  expect(chunks[0].slice(-400)).toBe(chunks[1].slice(0, 400));
  expect(Object.keys(contentQuestions([]))).toEqual(['kind', 'actionable', 'resolved', 'work']);
  expect(
    sourceLink({ source: 'slack', connectionId: 's', externalId: 'x', url: 'javascript:alert(1)' }),
  ).toBeNull();
  expect(() => validatePreparedEvidence(preparedDraftSchema.parse(draft('missing')), [])).toThrow();
  expect(() => safeDeltaUrl('https://evil.test/steal')).toThrow();
});
test('chunk windows and excerpts never split an emoji at their boundaries', async () => {
  const emoji = '\u{1F600}';
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  // Put an emoji across each window start (3600, 7200) and end (4000, 7600).
  const chars = 'x'.repeat(8000).split('');
  for (const at of [3600, 4000, 7200, 7600]) chars.splice(at - 1, 2, emoji[0], emoji[1]);
  const text = chars.join('');
  expect(text.length).toBe(8000);
  const chunks = contentChunks(text);
  expect(chunks).toHaveLength(3);
  for (const chunk of chunks) expect(lone.test(chunk)).toBe(false);
  expect(chunks.join('').split(emoji).length - 1).toBeGreaterThanOrEqual(4);
  expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);

  const t = convexTest(schema, modules);
  await seed(t);
  await t.mutation(content.upsert, {
    ...scope,
    items: [{ ...source('2'), externalId: 'owner-emoji', text }],
  });
  const claimed = (await t.mutation(content.claimItems, scope)).find(
    (row: any) => row.externalId === 'owner-emoji',
  );
  expect(
    await t.mutation(content.completeItem, {
      ...scope,
      id: claimed._id,
      version: claimed.version,
      lease: claimed.lease,
      labels,
      vectors: chunks.map(() => Array(1536).fill(0.01)),
    }),
  ).toBe(true);
  const stored = await t.run((ctx) =>
    ctx.db
      .query('contentChunks')
      .withIndex('by_item', (q) => q.eq('itemId', claimed._id))
      .collect(),
  );
  expect(stored).toHaveLength(3);
  const json = JSON.stringify(stored.map((chunk) => chunk.text));
  expect(json).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
  for (const chunk of JSON.parse(json)) expect(lone.test(chunk)).toBe(false);

  // The head cut (3000), the tail cut (-2000) and each excerpt edge split an emoji.
  const long = `${'y'.repeat(2999)}${emoji}${'z'.repeat(20_000)}${emoji}${'b'.repeat(159)}budget${emoji}${'w'.repeat(1999)}`;
  expect(lone.test(long.slice(0, 3000))).toBe(true);
  expect(lone.test(long.slice(-2000))).toBe(true);
  expect(lone.test(long.slice(long.indexOf('budget') - 160))).toBe(true);
  for (const excerpt of [
    researchExcerpt(long, ['budget']),
    contentExcerpt(long, 'budget', 2200),
    contentExcerpt(`budget${emoji}tail`, 'budget', 7),
  ])
    expect(lone.test(excerpt)).toBe(false);
  expect(contentExcerpt(`budget${emoji}tail`, 'budget', 7)).toBe('budget…');
  expect(contentExcerpt('plain budget text', 'budget', 6)).toBe('plain …');
});
test('bounded downloads reject dishonest and absent lengths and extract text without executing markup', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(MAX_DOWNLOAD_BYTES + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(boundedBytes(new Response(stream, { headers: { 'Content-Length': '1' } }))).rejects.toThrow(
    'size limit',
  );
  expect(cancelled).toBe(true);
  const extracted = await extractContent(
    new TextEncoder().encode('<h1>Requirements</h1><p>Signed approval</p>'),
    'text/html',
    'test.html',
  );
  expect(extracted.text).toContain('Signed approval');
  expect(extracted.text).not.toContain('<p>');
});

test('completed census removes unseen files, preserves seen files, and rejects foreign leases', async () => {
  const t = convexTest(schema, modules);
  const old = await seed(t);
  await classify(t, old);
  await t.mutation(content.upsert, { ...scope, items: [{ ...source(), externalId: 'survives' }] });
  const scan = await t.mutation(content.claimSync, { ...scope, connectionId: 'drive' });
  const args = { ...scope, connectionId: 'drive', generation: 'rescan', lease: scan.lease };
  await expect(t.mutation(content.reconcileScan, { ...args, userId: 'foreign' })).rejects.toThrow();
  await t.mutation(content.reconcileScan, { ...args, keys: ['google_drive:drive:survives'] });
  const page = await t.mutation(content.reconcileScan, args);
  expect(page.done).toBe(true);
  expect(
    (await t.query(content.search, { ...scope, query: 'approval' })).map((r: any) => r.externalId),
  ).toEqual(['survives']);
  expect(await t.run((ctx) => ctx.db.query('contentChunks').collect())).toEqual([]);
});

test('changed sources keep a draft visible while reclassifying; concurrent notes invalidate an in-flight generation', async () => {
  const t = convexTest(schema, modules);
  const row = await seed(t);
  const proposal = await prepare(t, row);
  await t.mutation(content.upsert, { ...scope, items: [source('2')] });
  const pending = (await t.query(preparations.list, scope))[0];
  expect(pending.draft.title).toBe(proposal.draft.title);
  expect(pending.needsRefresh).toBe(true);
  const [newItem] = await t.mutation(content.claimItems, scope);
  await classify(t, newItem);
  const claim = await t.mutation(preparations.claim, scope);
  await t.mutation(preparations.update, {
    ...scope,
    id: claim._id,
    revision: claim.revision,
    operation: 'edit',
    notes: 'Use the revised scope.',
  });
  expect(
    await t.mutation(preparations.complete, {
      ...scope,
      id: claim._id,
      lease: claim.lease,
      revision: claim.revision,
      seedVersion: '2',
      draft: draft(row._id),
      sources: [{ id: row._id, version: '2' }],
    }),
  ).toBe(false);
  const current = (await t.query(preparations.list, scope))[0];
  expect(current.userNotes).toBe('Use the revised scope.');
  expect(current.needsRefresh).toBe(true);
  await expect(
    t.mutation(preparations.update, {
      ...scope,
      id: current._id,
      revision: current.revision,
      operation: 'adopt',
    }),
  ).rejects.toThrow('Refresh');
});

test('list adoption creates list items and attached research without an execution plan', async () => {
  const t = convexTest(schema, modules);
  const row = await seed(t);
  await classify(t, row);
  const claim = await t.mutation(preparations.claim, scope);
  await t.mutation(preparations.complete, {
    ...scope,
    id: claim._id,
    lease: claim.lease,
    revision: claim.revision,
    seedVersion: '1',
    draft: { ...draft(row._id), shape: 'list' },
    sources: [{ id: row._id, version: '1' }],
  });
  const current = (await t.query(preparations.list, scope))[0];
  const adopted = await t.mutation(preparations.update, {
    ...scope,
    id: current._id,
    revision: current.revision,
    operation: 'adopt',
  });
  const work = await t.run((ctx) => ctx.db.get(adopted.workId));
  expect(work.shape).toBe('list');
  expect(work.listItems).toHaveLength(2);
  expect(work.latestPlanId).toBeUndefined();
  expect(await t.run((ctx) => ctx.db.query('albatrossIntentPlans').collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query('albatrossEvidence').collect())).toHaveLength(2);
});

test('completed or removed related work retires its preparation without recreating it as new work', async () => {
  for (const closed of ['done', 'archived', 'released', 'deleted']) {
    const t = convexTest(schema, modules);
    const row = await seed(t);
    const proposal = await prepare(t, row);
    const workId = await t.run(async (ctx) => {
      const id = await ctx.db.insert('albatrossIntents', {
        userId: scope.userId,
        externalId: 'existing-launch',
        rawText: 'Launch',
        title: 'Launch',
        source: 'import',
        status: 'ready',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.patch(row._id, { labels: { ...labels, workId: String(id) } });
      await ctx.db.patch(proposal._id, { workId: id, key: `work:${id}`, needsRefresh: true });
      return id;
    });
    const claim = await t.mutation(preparations.claim, scope);
    await t.run(async (ctx) => {
      if (closed === 'deleted') await ctx.db.delete(workId);
      else await ctx.db.patch(workId, { workState: closed });
    });
    expect(await t.query(preparations.list, scope)).toEqual([]);
    expect(
      await t.mutation(preparations.complete, {
        ...scope,
        id: claim._id,
        lease: claim.lease,
        revision: claim.revision,
        seedVersion: row.version,
        draft: draft(row._id),
        sources: [{ id: row._id, version: row.version }],
      }),
    ).toBe(false);
    expect(await t.mutation(preparations.claim, scope)).toBeNull();
    expect((await t.run((ctx) => ctx.db.get(proposal._id)))?.status).toBe('resolved');
    expect(await t.run((ctx) => ctx.db.query('briefPreparations').collect())).toHaveLength(1);
  }
});

test('semantic retrieval is owner-filtered and removes stale or disconnected vectors', async () => {
  const t = convexTest(schema, modules);
  const row = await seed(t);
  const foreign = await seed(t, 'foreign');
  await classify(t, row);
  await t.mutation(content.completeItem, {
    ...scope,
    userId: 'foreign',
    id: foreign._id,
    version: foreign.version,
    lease: foreign.lease,
    labels,
    vectors: [Array(1536).fill(0.01)],
  });
  expect(
    (await t.action(content.semanticSearch, { ...scope, vector: Array(1536).fill(0.01) })).map(
      (s: any) => s._id,
    ),
  ).toEqual([row._id]);
  await t.mutation(content.upsert, { ...scope, items: [source('2')] });
  expect(await t.action(content.semanticSearch, { ...scope, vector: Array(1536).fill(0.01) })).toEqual([]);
});

test('PDF extraction reads selectable text without a browser', async () => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 12 Tf 20 250 Td (Signed approval is required.) Tj ET';
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  const value = await extractContent(new TextEncoder().encode(pdf), 'application/pdf', 'approval.pdf');
  expect(value.text).toContain('Signed approval is required.');
  expect(value.partial).toBe(false);
});

test('content tombstones without text are accepted and malformed attachment identifiers fail closed', async () => {
  const t = convexTest(schema, modules);
  await seed(t);
  const { text: _text, ...withoutBody } = source('deleted');
  expect(await t.mutation(content.upsert, { ...scope, items: [{ ...withoutBody, deleted: true }] })).toEqual({
    changed: 1,
  });
  expect(await t.query(content.search, { ...scope, query: 'approval' })).toEqual([]);
  await t.run((ctx) =>
    ctx.db.insert('connectedAccounts', {
      userId: 'owner',
      accountId: 'mail',
      email: 'owner@example.test',
      provider: 'google',
      grantId: 'grant',
      status: 'connected',
      scopes: [],
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  for (const id of ['null', '{}', '[1,"attachment"]', '["message"]'])
    await t.mutation(content.upsert, {
      ...scope,
      items: [{ ...source(), source: 'attachment', connectionId: 'mail', externalId: id }],
    });
  expect(await t.query(content.search, { ...scope, query: 'approval' })).toEqual([]);
});

import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { createBriefComponentRoutes } from '../app/api/briefs/components/route';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { runWithAiRequestContext } from '../lib/ai/context';
import { AuthRequiredError } from '../lib/auth/current-user';
import { briefComponentStore } from '../lib/brief/component-state';
import { composeEditorialDocument } from '../lib/brief/editorial';
import { componentResponseRefSchema } from '../lib/brief/response';
import { readBriefResponseContext } from '../lib/brief/response-context';
import * as hosted from '../lib/hosted/convex';
import * as hostedEnv from '../lib/hosted/env';
import { kvCompareAndSwap, kvUpsert } from '../lib/store/kv';
import { briefComponentFixtures } from './fixtures/brief-components';
import { editorialFixture } from './fixtures/editorial';
import './tools/harness';

test('hosted component writes carry the authenticated tenant and expected revision to Convex', async () => {
  const configured = spyOn(hostedEnv, 'isConvexConfigured').mockReturnValue(true);
  const mutation = spyOn(hosted, 'convexMutation').mockResolvedValue(false);
  try {
    const doc = { revision: 'next', value: ['review'] };
    const result = await runWithAiRequestContext({ userId: 'hosted-owner' }, () =>
      kvCompareAndSwap('briefComponentState', 'edition:choice', 'previous', doc, 'edition'),
    );
    expect(result).toBe(false);
    expect(mutation).toHaveBeenCalledTimes(1);
    const [fn, args] = mutation.mock.calls[0];
    expect(getFunctionName(fn)).toBe('userData:compareAndSwapDoc');
    expect(args).toEqual({
      userId: 'hosted-owner',
      kind: 'briefComponentState',
      key: 'edition:choice',
      expectedRevision: 'previous',
      doc,
      ref: 'edition',
    });
    await expect(
      runWithAiRequestContext({ userId: undefined }, () =>
        kvCompareAndSwap('briefComponentState', 'edition:choice', null, doc),
      ),
    ).rejects.toThrow('No user on request context');
    expect(mutation).toHaveBeenCalledTimes(1);
  } finally {
    mutation.mockRestore();
    configured.mockRestore();
  }
});

async function seed(userId: string, id: string) {
  const { edition, letter, modules, plan } = editorialFixture();
  plan.regions[0].tree = {
    kind: 'component',
    id: 'choice',
    component: 'option-list',
    props: briefComponentFixtures['option-list'],
    summary: 'Prepare the support review',
    sources: ['lede'],
  };
  edition.document = composeEditorialDocument(letter, modules, plan);
  edition.editorial = { plan, mode: 'generated' };
  edition._id = id;
  await runWithAiRequestContext({ userId }, () => kvUpsert('dailyReport', id, edition));
  return edition;
}

test('edition answers persist per user and per component, validate values and reject stale or concurrent writes', async () => {
  const reportId = `edition-${crypto.randomUUID()}`;
  await seed('owner', reportId);
  const identity = { reportId, componentId: 'choice' };
  const read = await briefComponentStore.read('owner', identity);
  expect(read.state.value).toBeNull();
  const initial = { ...identity, stamp: read.state.stamp, revision: null };
  await expect(briefComponentStore.read('other-user', identity)).rejects.toMatchObject({ status: 404 });
  await expect(
    briefComponentStore.write('other-user', { ...initial, value: ['review'] }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    briefComponentStore.write('owner', { ...initial, value: ['not-an-option'] }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    briefComponentStore.write('owner', { ...initial, stamp: 'b'.repeat(64), value: ['review'] }),
  ).rejects.toMatchObject({ status: 409 });
  const races = await Promise.allSettled([
    briefComponentStore.write('owner', { ...initial, value: ['review'] }),
    briefComponentStore.write('owner', { ...initial, value: ['clarify'] }),
  ]);
  expect(races.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(races.filter((r) => r.status === 'rejected')).toHaveLength(1);
  const saved = await briefComponentStore.read('owner', identity);
  expect(saved.state.revision).toBeTruthy();
  const updated = await briefComponentStore.write('owner', {
    ...initial,
    revision: saved.state.revision,
    value: ['clarify'],
  });
  expect((await briefComponentStore.read('owner', identity)).state).toEqual(updated);
  const reference = componentResponseRefSchema.parse({
    kind: 'component',
    ...identity,
    stamp: updated.stamp,
    revision: updated.revision,
  });
  const context = await readBriefResponseContext('owner', reference);
  expect(context.systemContext).toContain('"answers":["clarify"]');
  expect(context.systemContext).toContain('not proof that an external action has completed');
  await expect(readBriefResponseContext('other-user', reference)).rejects.toMatchObject({ status: 404 });
  await expect(
    readBriefResponseContext('owner', { ...reference, revision: saved.state.revision! }),
  ).rejects.toMatchObject({ status: 409 });
});

test('a regenerated component invalidates its old answers and refuses a forged component id', async () => {
  const id = `edition-${crypto.randomUUID()}`;
  const edition = await seed('owner', id);
  const identity = { reportId: id, componentId: 'choice' };
  const { state } = await briefComponentStore.read('owner', identity);
  await briefComponentStore.write('owner', {
    ...identity,
    stamp: state.stamp,
    revision: state.revision,
    value: ['review'],
  });
  const plan = edition.editorial!.plan;
  const tree = plan.regions[0].tree;
  if (tree.kind !== 'component') throw new Error('Expected component');
  tree.props = { options: [{ id: 'new', label: 'New decision' }] };
  const { letter, modules } = editorialFixture();
  edition.document = composeEditorialDocument(letter, modules, plan);
  await runWithAiRequestContext({ userId: 'owner' }, () => kvUpsert('dailyReport', id, edition));
  const changed = await briefComponentStore.read('owner', identity);
  expect(changed.state.stamp).not.toBe(state.stamp);
  expect(changed.state.value).toBeNull();
  await expect(
    briefComponentStore.write('owner', {
      ...identity,
      stamp: state.stamp,
      revision: null,
      value: ['review'],
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    briefComponentStore.read('owner', { ...identity, componentId: 'invented' }),
  ).rejects.toMatchObject({ status: 404 });
});

test('component API requires authentication, rate limits, preserves user scope, bounds requests and never caches answers', async () => {
  const reportId = `edition-${crypto.randomUUID()}`;
  await seed('route-owner', reportId);
  const calls: unknown[] = [];
  const routes = createBriefComponentRoutes({
    user: async () => ({ userId: 'route-owner' }) as any,
    store: briefComponentStore,
    rate: async (input) => {
      calls.push(input);
    },
  });
  const url = `https://app.test/api/briefs/components?reportId=${reportId}&componentId=choice`;
  const response = await routes.GET(new NextRequest(url));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const state = await response.json();
  expect(calls[0]).toMatchObject({ userId: 'route-owner', key: 'brief-components-read' });
  const post = (body: unknown) =>
    routes.POST(
      new NextRequest(url, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    );
  expect(
    (
      await post({
        reportId,
        componentId: 'choice',
        stamp: state.stamp,
        revision: null,
        value: ['review'],
        userId: 'someone-else',
      })
    ).status,
  ).toBe(400);
  expect(
    (await post({ reportId, componentId: 'choice', stamp: state.stamp, revision: null, value: ['review'] }))
      .status,
  ).toBe(200);
  expect((await post({ value: 'x'.repeat(30001) })).status).toBe(413);
  const unauthorized = createBriefComponentRoutes({
    user: async () => {
      throw new AuthRequiredError('Sign in required.');
    },
    store: briefComponentStore,
    rate: async () => {},
  });
  expect((await unauthorized.GET(new NextRequest(url))).status).toBe(401);
});

const secret = 'brief-component-convex-test';
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = secret;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});
test('the deployed Convex mutation enforces atomic revision checks and tenant isolation', async () => {
  const t = convexTest(schema, {
    '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
    '../convex/userData.ts': () => import('../convex/userData'),
  });
  const f = (api as any).userData;
  const args = {
    internalSecret: secret,
    userId: 'a',
    kind: 'briefComponentState',
    key: 'edition:choice',
    expectedRevision: null,
    doc: { revision: 'v1', value: ['review'] },
  };
  expect(await t.mutation(f.compareAndSwapDoc, args)).toBe(true);
  expect(await t.mutation(f.compareAndSwapDoc, { ...args, doc: { revision: 'v2' } })).toBe(false);
  expect(
    await t.query(f.getDoc, { internalSecret: secret, userId: 'b', kind: args.kind, key: args.key }),
  ).toBeNull();
  expect(
    await t.mutation(f.compareAndSwapDoc, { ...args, expectedRevision: 'v1', doc: { revision: 'v2' } }),
  ).toBe(true);
  await expect(t.mutation(f.compareAndSwapDoc, { ...args, internalSecret: 'wrong' })).rejects.toThrow();
  await expect(t.mutation(f.compareAndSwapDoc, { ...args, kind: 'dailyReport' })).rejects.toThrow();
});

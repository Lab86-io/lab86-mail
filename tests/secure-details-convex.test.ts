import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';

// The Convex side of Passwords and IDs (docs/albatross-secure-store.md): rows
// hold sealed values only, every function needs the server secret, and the
// allow answer on a run counts once.

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/secureDetails.ts': () => import('../convex/secureDetails'),
  '../convex/albatrossStepRuns.ts': () => import('../convex/albatrossStepRuns'),
  '../convex/albatrossBrowserSessions.ts': () => import('../convex/albatrossBrowserSessions'),
  '../convex/albatrossWorkV2.ts': () => import('../convex/albatrossWorkV2'),
  '../convex/albatrossIntents.ts': () => import('../convex/albatrossIntents'),
  '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
  '../convex/albatrossNotifications.ts': () => import('../convex/albatrossNotifications'),
  '../convex/boards.ts': () => import('../convex/boards'),
  '../convex/mobile.ts': () => import('../convex/mobile'),
  '../convex/albatross.ts': () => import('../convex/albatross'),
};

const SECRET = 'secure-convex-secret';
const userId = 'secure_user';
const caller = { internalSecret: SECRET, userId };
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

const harness = () => convexTest(schema, modules);
const sealed = { payloadSealed: 'sv1.aaaa.bbbb.cccc', dataKeyWrapped: 'sv1.dddd.eeee.ffff', kekId: 's1' };
const ITEM = 'si_aaaaaaaaaaaaaaaaaaaaaa';

function create(t: ReturnType<typeof harness>, overrides: Record<string, unknown> = {}) {
  return t.mutation(api.secureDetails.createItem, {
    ...caller,
    itemId: ITEM,
    kind: 'id_number',
    label: "Driver's license",
    sites: [],
    hints: [{ field: 'number', hint: 'ends 4821' }],
    facts: [{ name: 'type', value: 'drivers_license' }],
    sealed,
    ...overrides,
  } as any);
}

describe('secureDetails', () => {
  test('every function needs the server secret', async () => {
    const t = harness();
    await expect(t.query(api.secureDetails.listItems, { userId })).rejects.toThrow(/internal secret/);
    await expect(t.query(api.secureDetails.listSealed, { userId, internalSecret: 'wrong' })).rejects.toThrow(
      /internal secret/,
    );
    await expect(create(t, { internalSecret: undefined })).rejects.toThrow(/internal secret/);
  });

  test('a row takes sealed values only, a real item id, and plain sites', async () => {
    const t = harness();
    await expect(create(t, { sealed: { ...sealed, payloadSealed: 'D1234821' } })).rejects.toThrow(
      /must be sealed/,
    );
    await expect(create(t, { sealed: { ...sealed, dataKeyWrapped: 'v2.k1.x.y.z' } })).rejects.toThrow(
      /must be sealed/,
    );
    await expect(create(t, { itemId: 'item-1' })).rejects.toThrow(/item id/);
    await expect(create(t, { sites: ['https://chase.com'] })).rejects.toThrow(/Invalid site/);
    await expect(create(t, { label: ' ' })).rejects.toThrow(/label/);
    await expect(
      create(t, { hints: Array.from({ length: 13 }, () => ({ field: 'a', hint: 'b' })) }),
    ).rejects.toThrow(/Too many/);
    await create(t);
    await expect(create(t)).rejects.toThrow(/already exists/);
  });

  test('the list holds no sealed value; listSealed does, for the owner only', async () => {
    const t = harness();
    await create(t);
    const [view] = await t.query(api.secureDetails.listItems, caller);
    expect(view).toMatchObject({
      itemId: ITEM,
      kind: 'id_number',
      label: "Driver's license",
      lastUsedAt: null,
    });
    expect(JSON.stringify(view)).not.toContain('sv1');
    expect((await t.query(api.secureDetails.listSealed, caller))[0].payloadSealed).toBe(sealed.payloadSealed);
    expect(await t.query(api.secureDetails.listSealed, { ...caller, userId: 'other' })).toEqual([]);
  });

  test('update, addSite, and new values end every Allow once grant', async () => {
    const t = harness();
    await create(t);
    expect(await t.mutation(api.secureDetails.addSite, { ...caller, itemId: ITEM, site: 'ny.gov' })).toEqual({
      added: true,
    });
    expect(await t.mutation(api.secureDetails.addSite, { ...caller, itemId: ITEM, site: 'ny.gov' })).toEqual({
      added: false,
    });
    const grant = { ...caller, itemId: ITEM, site: 'ca.gov', workId: 'w1', stepKey: 's1' };
    expect(await t.mutation(api.secureDetails.grantOnce, { ...grant, ttlMs: 60_000 })).toEqual({
      granted: true,
    });
    expect(await t.query(api.secureDetails.hasGrant, grant)).toBe(true);
    expect(await t.query(api.secureDetails.hasGrant, { ...grant, stepKey: 's2' })).toBe(false);
    expect(await t.query(api.secureDetails.hasGrant, { ...grant, site: 'tx.gov' })).toBe(false);
    await t.mutation(api.secureDetails.updateItem, { ...caller, itemId: ITEM, label: 'NY license' });
    expect(await t.query(api.secureDetails.hasGrant, grant)).toBe(true);
    await t.mutation(api.secureDetails.updateItem, {
      ...caller,
      itemId: ITEM,
      sealed: { ...sealed, payloadSealed: 'sv1.n.e.w' },
    });
    expect(await t.query(api.secureDetails.hasGrant, grant)).toBe(false);
    const [view] = await t.query(api.secureDetails.listItems, caller);
    expect(view).toMatchObject({ label: 'NY license', sites: ['ny.gov'] });
    expect(
      await t.mutation(api.secureDetails.updateItem, {
        ...caller,
        itemId: 'si_bbbbbbbbbbbbbbbbbbbbbb',
        label: 'x',
      }),
    ).toEqual({ updated: false });
    expect(
      await t.mutation(api.secureDetails.grantOnce, {
        ...grant,
        itemId: 'si_bbbbbbbbbbbbbbbbbbbbbb',
        ttlMs: 1,
      }),
    ).toEqual({ granted: false });
  });

  test('uses carry the Work title and set lastUsedAt; delete takes grants and uses with it', async () => {
    const t = harness();
    await create(t);
    const workId = await t.run((ctx) =>
      ctx.db.insert('albatrossIntents', {
        userId,
        rawText: 'Renew the car registration',
        title: 'Renew the car registration',
        source: 'text',
        status: 'ready',
        workState: 'active',
        agentState: 'idle',
        createdAt: 1,
        updatedAt: 1,
      } as any),
    );
    await t.mutation(api.secureDetails.recordUse, {
      ...caller,
      itemId: ITEM,
      outcome: 'asked',
      site: 'ny.gov',
      workId: String(workId),
    });
    await t.mutation(api.secureDetails.recordUse, {
      ...caller,
      itemId: ITEM,
      outcome: 'typed',
      field: 'number',
      site: 'ny.gov',
      host: 'dmv.ny.gov',
      workId: String(workId),
      runId: 'r1',
    });
    const uses = await t.query(api.secureDetails.listUses, { ...caller, itemId: ITEM });
    expect(uses.map((use) => use.outcome)).toEqual(['typed', 'asked']);
    expect(uses[0]).toMatchObject({
      workTitle: 'Renew the car registration',
      host: 'dmv.ny.gov',
      field: 'number',
    });
    expect((await t.query(api.secureDetails.listItems, caller))[0].lastUsedAt).toBeNumber();
    expect(
      await t.mutation(api.secureDetails.recordUse, {
        ...caller,
        itemId: 'si_bbbbbbbbbbbbbbbbbbbbbb',
        outcome: 'typed',
      }),
    ).toEqual({ recorded: false });
    await t.mutation(api.secureDetails.grantOnce, {
      ...caller,
      itemId: ITEM,
      site: 'ny.gov',
      workId: 'w',
      stepKey: 's',
      ttlMs: 60_000,
    });
    expect(await t.mutation(api.secureDetails.deleteItem, { ...caller, itemId: ITEM })).toEqual({
      deleted: true,
    });
    expect(await t.mutation(api.secureDetails.deleteItem, { ...caller, itemId: ITEM })).toEqual({
      deleted: false,
    });
    const left = await t.run(async (ctx) => [
      ...(await ctx.db.query('secureGrants').collect()),
      ...(await ctx.db.query('secureUses').collect()),
    ]);
    expect(left).toEqual([]);
  });

  test('prune removes old uses and ended grants', async () => {
    const t = harness();
    await create(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('secureUses', { userId, itemId: ITEM, outcome: 'typed', at: 1 });
      await ctx.db.insert('secureUses', { userId, itemId: ITEM, outcome: 'typed', at: Date.now() });
      await ctx.db.insert('secureGrants', {
        userId,
        itemId: ITEM,
        site: 'ny.gov',
        workId: 'w',
        stepKey: 's',
        expiresAt: 1,
        createdAt: 1,
      });
    });
    expect(await t.mutation(internal.secureDetails.prune, {})).toEqual({ uses: 1, grants: 1 });
  });

  test('rotation pages and compare-and-set rewrap', async () => {
    const t = harness();
    await create(t);
    const page = await t.query(api.secureDetails.rotationPage, {
      internalSecret: SECRET,
      cursor: null,
      numItems: 10,
    });
    expect(page.rows).toEqual([
      expect.objectContaining({
        userId,
        itemId: ITEM,
        kind: 'id_number',
        dataKeyWrapped: sealed.dataKeyWrapped,
        kekId: 's1',
      }),
    ]);
    const id = page.rows[0].id as Id<'secureItems'>;
    const next = { internalSecret: SECRET, id, dataKeyWrapped: 'sv1.n.e.w', kekId: 's2' };
    expect(await t.mutation(api.secureDetails.rewrap, { ...next, expected: 'sv1.stale.x.y' })).toEqual({
      replaced: false,
    });
    expect(await t.mutation(api.secureDetails.rewrap, { ...next, expected: sealed.dataKeyWrapped })).toEqual({
      replaced: true,
    });
    await expect(
      t.mutation(api.secureDetails.rewrap, { ...next, expected: 'sv1.n.e.w', dataKeyWrapped: 'plain' }),
    ).rejects.toThrow(/sealed/);
  });
});

describe('allow_secure on a run', () => {
  test('settle keeps next.allow; the first answer counts once', async () => {
    const t = harness();
    const workId = await t.run((ctx) =>
      ctx.db.insert('albatrossIntents', {
        userId,
        rawText: 'Renew',
        title: 'Renew',
        source: 'text',
        status: 'ready',
        workState: 'active',
        agentState: 'idle',
        createdAt: 1,
        updatedAt: 1,
      } as any),
    );
    const { runId } = await t.mutation(api.albatrossStepRuns.enqueue, {
      ...caller,
      workId: String(workId),
      stepKey: 'step-1',
      stepIdentity: 'step:task:renew',
      stepTitle: 'Renew online',
      trigger: 'user',
    });
    const id = runId as Id<'albatrossStepRuns'>;
    expect(await t.mutation(api.albatrossStepRuns.answerAllow, { ...caller, id, scope: 'once' })).toBe(false);
    await t.mutation(api.albatrossStepRuns.claim, { ...caller, id, token: 'tk' });
    const allow = {
      itemId: ITEM,
      kind: 'id_number' as const,
      itemLabel: "Driver's license",
      fieldLabels: ['Number'],
      site: 'ny.gov',
      host: 'dmv.ny.gov',
    };
    await t.mutation(api.albatrossStepRuns.settle, {
      ...caller,
      id,
      token: 'tk',
      outcome: 'needs_answer',
      summary: 'Filled the plate number.',
      next: {
        kind: 'allow_secure',
        label: 'Answer',
        detail: "Use your saved Driver's license on ny.gov?",
        allow,
        target: { kind: 'secure', id: ITEM, url: 'https://dmv.ny.gov' },
      },
    });
    const view = await t.query(api.albatrossStepRuns.get, { ...caller, id });
    expect(view?.next).toMatchObject({
      kind: 'allow_secure',
      allow,
      allowAnswer: null,
      saveSignIn: null,
      target: { kind: 'secure' },
    });
    expect(await t.mutation(api.albatrossStepRuns.answerAllow, { ...caller, id, scope: 'once' })).toBe(true);
    expect(await t.mutation(api.albatrossStepRuns.answerAllow, { ...caller, id, scope: 'always' })).toBe(
      false,
    );
    const after = await t.query(api.albatrossStepRuns.get, { ...caller, id });
    expect(after?.next?.allowAnswer).toMatchObject({ scope: 'once' });
    await expect(
      t.mutation(api.albatrossStepRuns.answerAllow, { ...caller, userId: 'other', id, scope: 'once' }),
    ).rejects.toThrow(/not found/);
  });
});

test('a full prune batch schedules the next pass at once', async () => {
  const t = harness();
  await create(t);
  await t.run(async (ctx) => {
    for (let index = 0; index < 501; index += 1)
      await ctx.db.insert('secureUses', { userId, itemId: ITEM, outcome: 'typed', at: index + 1 });
  });
  expect(await t.mutation(internal.secureDetails.prune, {})).toEqual({ uses: 500, grants: 0 });
  const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
  expect(scheduled.map((job) => job.name)).toContain('secureDetails:prune');
});

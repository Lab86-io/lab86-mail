import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest, type TestConvex } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import { normalizeNylasContact } from '../lib/contacts/model';
import {
  __resetContactKicksForTest,
  maybeKickContactSync,
  setContactSyncDependenciesForTest,
  syncAccountContacts,
  syncUserContacts,
} from '../lib/contacts/sync';
import { storedContactPhotos } from '../lib/tools/photos';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/accounts.ts': () => import('../convex/accounts'),
  '../convex/contacts.ts': () => import('../convex/contacts'),
  '../convex/correspondents.ts': () => import('../convex/correspondents'),
};
const SECRET = 'contacts-edge-secret';
const ENV = ['LAB86_CONVEX_INTERNAL_SECRET', 'LAB86_MAIL_PUBLIC_URL'] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const key of ENV) saved[key] = process.env[key];
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
let restore: (() => void) | undefined;
const originalFetch = globalThis.fetch;
afterEach(() => {
  restore?.();
  restore = undefined;
  __resetContactKicksForTest();
  globalThis.fetch = originalFetch;
});

const USER = 'user_edge';
async function connect(t: TestConvex<typeof schema>, scopes: string[] = ['openid'], email = 'me@acme.com') {
  await t.mutation(api.accounts.upsertConnectedAccount, {
    internalSecret: SECRET,
    userId: USER,
    email,
    provider: 'google',
    grantId: 'g1',
    scopes,
  });
}
const contact = (id: string, name: string, email: string) =>
  normalizeNylasContact({ id, displayName: name, emails: [{ email }] }, 'address_book')!;

function wire(t: TestConvex<typeof schema>, nylas: any, overrides: Record<string, unknown> = {}) {
  let lease = 0;
  restore = setContactSyncDependenciesForTest({
    query: ((fn: any, args: any) => t.query(fn, { ...args, internalSecret: SECRET })) as any,
    mutate: ((fn: any, args: any) => t.mutation(fn, { ...args, internalSecret: SECRET })) as any,
    nylas: () => nylas,
    retry: (fn) => fn(),
    now: () => 1_800_000_000_000 + lease * 1_000,
    leaseId: () => `lease-${++lease}`,
    ...overrides,
  });
}
const error = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode, headers: {} });

describe('cron fan-out', () => {
  test('the tick calls the app for due users and needs its settings', async () => {
    const t = convexTest(schema, modules);
    await connect(t);
    const posts: any[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      posts.push({
        url,
        body: JSON.parse(String(init.body)),
        secret: (init.headers as any)['x-lab86-internal-secret'],
      });
      return new Response('{}', { status: 202 });
    }) as any;
    delete process.env.LAB86_MAIL_PUBLIC_URL;
    await t.action(internal.contacts.tick, {});
    expect(posts).toEqual([]);
    process.env.LAB86_MAIL_PUBLIC_URL = 'https://mail.example.test/';
    await t.action(internal.contacts.tick, {});
    expect(posts).toEqual([
      { url: 'https://mail.example.test/api/cron/contacts-sync', body: { userId: USER }, secret: SECRET },
    ]);
    await t.mutation(api.accounts.deleteConnectedAccount, {
      internalSecret: SECRET,
      userId: USER,
      accountId: 'g1',
    });
    posts.length = 0;
    await t.action(internal.contacts.tick, {});
    expect(posts).toEqual([]);
  });
});

describe('bounded batches', () => {
  test('search finds an address prefix that the name search cut off', async () => {
    const t = convexTest(schema, modules);
    await connect(t);
    await t.mutation(api.contacts.upsertContactBatch, {
      internalSecret: SECRET,
      userId: USER,
      accountId: 'g1',
      provider: 'google',
      contacts: [
        contact('c1', 'Ann One', 'one@x.io'),
        contact('c2', 'Ann Two', 'two@x.io'),
        contact('c3', 'Ann Three', 'three@x.io'),
        contact('c4', 'Xavier', 'ann@x.io'),
      ],
    });
    const found = await t.query(api.contacts.searchContacts, {
      internalSecret: SECRET,
      userId: USER,
      query: 'ann',
      limit: 1,
    });
    expect(found.contacts.map((row) => row.name)).toContain('Xavier');
  });

  test('contact and correspondent purges continue past one batch', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 201; i++) {
        await ctx.db.insert('contacts', {
          userId: USER,
          accountId: 'g1',
          provider: 'google',
          source: 'address_book',
          providerContactId: `c${i}`,
          emails: [],
          searchText: 'x',
          contentHash: 'h',
          createdAt: 1,
          updatedAt: 1,
        });
        await ctx.db.insert('correspondents', {
          userId: USER,
          email: `p${i}@x.io`,
          sentCount: 1,
          receivedCount: 0,
          bulkCount: 0,
          frecency: 1,
          score: 1,
          accounts: [{ accountId: 'g1', sent: 1, received: 0, lastAt: 1 }],
          searchText: 'x',
          updatedAt: 1,
        });
      }
    });
    expect(
      await t.mutation(internal.contacts.purgeContactsBatch, { userId: USER, accountId: 'g1' }),
    ).toMatchObject({
      done: false,
    });
    const first = await t.mutation(internal.correspondents.purgeAccountCorrespondents, {
      userId: USER,
      accountId: 'g1',
    });
    expect(first).toMatchObject({ deleted: 200, done: false });
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await t.finishInProgressScheduledFunctions();
    }
    expect(await t.run((ctx) => ctx.db.query('contacts').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('correspondents').collect())).toHaveLength(0);
  });
});

describe('sync failure paths', () => {
  const G = 'https://www.googleapis.com/auth/';

  test('every source failing gives an error state', async () => {
    const t = convexTest(schema, modules);
    await connect(t, [`${G}contacts.readonly`, `${G}contacts.other.readonly`, `${G}directory.readonly`]);
    wire(t, {
      grants: { find: async () => ({ data: {} }) },
      contacts: {
        list: async () => {
          throw error(502, 'Bad gateway');
        },
      },
    });
    const result = await syncAccountContacts({ userId: USER, accountId: 'g1', force: true });
    expect(result.status).toBe('error');
  });

  test('a gone grant on the scope read keeps the sources of the last pass', async () => {
    const t = convexTest(schema, modules);
    await connect(t, [`${G}contacts.readonly`]);
    let gone = false;
    wire(t, {
      grants: {
        find: async () => {
          if (gone) throw error(404, 'No grant found');
          return { data: {} };
        },
      },
      contacts: { list: async () => ({ data: [{ id: 'c1', emails: [{ email: 'ann@x.io' }] }] }) },
    });
    await syncAccountContacts({ userId: USER, accountId: 'g1', force: true });
    gone = true;
    const result = await syncAccountContacts({ userId: USER, accountId: 'g1', force: true });
    expect(result.status).toBe('error');
    expect(result.sources?.find((entry) => entry.source === 'address_book')).toMatchObject({
      state: 'ok',
      count: 1,
    });
  });

  test('a throwing pass is reported by the user pass and by a kick', async () => {
    const t = convexTest(schema, modules);
    await connect(t);
    wire(
      t,
      {},
      {
        mutate: (async () => {
          throw new Error('convex down');
        }) as any,
      },
    );
    const results = await syncUserContacts(USER);
    expect(results).toEqual([{ ok: false, accountId: 'g1', reason: 'convex down' }]);
    expect(maybeKickContactSync({ userId: USER, accountId: 'g1' })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The failed kick clears its debounce, so the next kick runs.
    expect(maybeKickContactSync({ userId: USER, accountId: 'g1' })).toBe(true);
  });
});

describe('stored contact photos', () => {
  test('one query when Convex is set up; nothing otherwise', async () => {
    const calls: any[] = [];
    const query = (async (_fn: any, args: any) => {
      calls.push(args);
      return { photos: [{ email: 'a@b.io', url: 'https://p.example/a.png' }] };
    }) as any;
    expect(await storedContactPhotos('u', ['a@b.io'], query, () => true)).toEqual(
      new Map([['a@b.io', 'https://p.example/a.png']]),
    );
    expect(calls).toEqual([{ userId: 'u', emails: ['a@b.io'] }]);
    expect(await storedContactPhotos('u', ['a@b.io'], query, () => false)).toEqual(new Map());
    expect(await storedContactPhotos(null, ['a@b.io'], query, () => true)).toEqual(new Map());
    expect(await storedContactPhotos('u', ['a@b.io'], (async () => null) as any, () => true)).toEqual(
      new Map(),
    );
  });
});

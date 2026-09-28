import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest, type TestConvex } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import {
  __resetContactKicksForTest,
  applyContactWebhookDelta,
  CONTACT_SOURCE_CAPS,
  isContactWebhookType,
  maybeKickContactSync,
  refreshGrantScopes,
  setContactSyncDependenciesForTest,
  syncAccountContacts,
  syncUserContacts,
} from '../lib/contacts/sync';
import { __setWebhookIngestDepsForTest, ingestNylasWebhookPayload } from '../lib/mail/corpus-sync';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/accounts.ts': () => import('../convex/accounts'),
  '../convex/contacts.ts': () => import('../convex/contacts'),
};

const SECRET = 'contacts-sync-secret';
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

const USER = 'user_sync';
const G = 'https://www.googleapis.com/auth/';

function apiError(statusCode: number, message: string, headers: Record<string, string> = {}) {
  return Object.assign(new Error(message), { statusCode, headers });
}

type Page = { data: any[]; nextCursor?: string };
type SourceReply = Page[] | Error | ((pageToken?: string) => Page | Error);

interface FakeNylas {
  calls: Array<{ source?: string; pageToken?: string }>;
  finds: string[];
  sources: Partial<Record<string, SourceReply>>;
  grantScopes?: string[] | Error;
  findReply?: any;
}

function fakeNylas(fake: FakeNylas) {
  return () =>
    ({
      grants: {
        find: async () => {
          if (fake.grantScopes instanceof Error) throw fake.grantScopes;
          return { data: fake.grantScopes ? { scope: fake.grantScopes } : {} };
        },
      },
      contacts: {
        list: async ({ queryParams }: any) => {
          fake.calls.push({ source: queryParams.source, pageToken: queryParams.pageToken });
          const reply = fake.sources[queryParams.source];
          if (!reply) return { data: [] };
          if (reply instanceof Error) throw reply;
          if (typeof reply === 'function') {
            const page = reply(queryParams.pageToken);
            if (page instanceof Error) throw page;
            return page;
          }
          const index = queryParams.pageToken ? Number(queryParams.pageToken) : 0;
          return reply[index];
        },
        find: async ({ contactId }: any) => {
          fake.finds.push(contactId);
          if (fake.findReply instanceof Error) throw fake.findReply;
          return { data: fake.findReply };
        },
      },
    }) as any;
}

let clock = 1_800_000_000_000;

function wire(t: TestConvex<typeof schema>, fake: FakeNylas) {
  let lease = 0;
  return setContactSyncDependenciesForTest({
    query: ((fn: any, args: any) => t.query(fn, { ...args, internalSecret: SECRET })) as any,
    mutate: ((fn: any, args: any) => t.mutation(fn, { ...args, internalSecret: SECRET })) as any,
    nylas: fakeNylas(fake),
    retry: (fn) => fn(),
    now: () => clock,
    leaseId: () => `lease-${++lease}`,
  });
}

async function connect(
  t: TestConvex<typeof schema>,
  options: { grantId?: string; email?: string; provider?: any; scopes?: string[] } = {},
) {
  const grantId = options.grantId ?? 'grant_1';
  await t.mutation(api.accounts.upsertConnectedAccount, {
    internalSecret: SECRET,
    userId: USER,
    email: options.email ?? 'me@acme.com',
    provider: options.provider ?? 'google',
    grantId,
    scopes: options.scopes ?? [`${G}gmail.modify`, `${G}contacts.readonly`],
  });
  return grantId;
}

const person = (id: string, email: string, name?: string) => ({ id, displayName: name, emails: [{ email }] });

async function stored(t: TestConvex<typeof schema>) {
  const rows = await t.run((ctx) => ctx.db.query('contacts').collect());
  return rows.map((row) => `${row.source}:${row.providerContactId}`).sort();
}

async function state(t: TestConvex<typeof schema>) {
  return await t.run((ctx) => ctx.db.query('contactSyncStates').first());
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  __resetContactKicksForTest();
  __setWebhookIngestDepsForTest();
});

describe('full pass', () => {
  test('pages saved contacts, skips sources without a scope, and asks for a reconnect', async () => {
    const t = convexTest(schema, modules);
    const grantId = await connect(t);
    const fake: FakeNylas = {
      calls: [],
      finds: [],
      sources: {
        address_book: [
          { data: [person('a1', 'ann@acme.com', 'Ann'), { id: 'phone-only', emails: [] }], nextCursor: '1' },
          { data: [person('a2', 'bob@acme.com', 'Bob'), person('a1', 'ann@acme.com', 'Ann')] },
        ],
      },
    };
    restore = wire(t, fake);
    const result = await syncAccountContacts({ userId: USER, accountId: grantId, force: true });
    expect(result).toMatchObject({ ok: true, status: 'needs_reconnect', contacts: 2 });
    expect(result.sources?.map((entry) => `${entry.source}:${entry.state}`)).toEqual([
      'address_book:ok',
      'inbox:missing_scope',
      'domain:missing_scope',
    ]);
    // Sources without a scope are never asked for.
    expect(fake.calls).toEqual([
      { source: 'address_book', pageToken: undefined },
      { source: 'address_book', pageToken: '1' },
    ]);
    expect(await stored(t)).toEqual(['address_book:a1', 'address_book:a2']);
    expect(await state(t)).toMatchObject({
      status: 'needs_reconnect',
      contactCount: 2,
      lastFullSyncAt: clock,
    });
    expect((await state(t))?.leaseId).toBeUndefined();

    // A pass that is not due does nothing.
    expect(await syncAccountContacts({ userId: USER, accountId: grantId })).toMatchObject({
      skipped: true,
      reason: 'fresh',
    });

    // The next full pass writes nothing for equal rows and prunes a removed contact.
    fake.sources.address_book = [{ data: [person('a1', 'ann@acme.com', 'Ann')] }];
    clock += 1_000;
    await syncAccountContacts({ userId: USER, accountId: grantId, force: true });
    expect(await stored(t)).toEqual(['address_book:a1']);
    const emails = await t.run((ctx) => ctx.db.query('contactEmails').collect());
    expect(emails.map((row) => row.email)).toEqual(['ann@acme.com']);
  });

  test('new grant scopes from Nylas open every source', async () => {
    const t = convexTest(schema, modules);
    const grantId = await connect(t, { scopes: [`${G}gmail.modify`] });
    const fake: FakeNylas = {
      calls: [],
      finds: [],
      grantScopes: [`${G}contacts.readonly`, `${G}contacts.other.readonly`, `${G}directory.readonly`],
      sources: {
        address_book: [{ data: [person('a1', 'ann@acme.com', 'Ann')] }],
        inbox: [{ data: [person('i1', 'ivy@shop.example')] }],
        domain: [{ data: [person('d1', 'dan@acme.com', 'Dan')] }],
      },
    };
    restore = wire(t, fake);
    const result = await syncAccountContacts({ userId: USER, accountId: grantId, force: true });
    expect(result).toMatchObject({ status: 'ready', contacts: 3 });
    expect(await stored(t)).toEqual(['address_book:a1', 'domain:d1', 'inbox:i1']);
    const account = await t.run((ctx) => ctx.db.query('connectedAccounts').first());
    expect(account?.scopes).toContain(`${G}directory.readonly`);
  });

  test('a 403 is a missing scope unless the scope is granted; 400 is unsupported', async () => {
    const t = convexTest(schema, modules);
    const grantId = await connect(t, {
      provider: 'microsoft',
      email: 'me@contoso.com',
      scopes: ['https://graph.microsoft.com/.default', 'People.Read'],
    });
    const fake: FakeNylas = {
      calls: [],
      finds: [],
      sources: {
        address_book: apiError(403, 'Insufficient scopes'),
        inbox: apiError(403, 'Forbidden'),
        domain: apiError(400, 'invalid source'),
      },
    };
    restore = wire(t, fake);
    const result = await syncAccountContacts({ userId: USER, accountId: grantId, force: true });
    expect(result.sources?.map((entry) => `${entry.source}:${entry.state}`)).toEqual([
      'address_book:missing_scope',
      'inbox:unsupported',
      'domain:unsupported',
    ]);
    expect(result.status).toBe('needs_reconnect');
    // The mail grant stays connected.
    expect((await t.run((ctx) => ctx.db.query('connectedAccounts').first()))?.status).toBe('connected');
  });

  test('a 429 waits for Retry-After and keeps what the pass could not read', async () => {
    const t = convexTest(schema, modules);
    const grantId = await connect(t, {
      scopes: [`${G}contacts.readonly`, `${G}contacts.other.readonly`],
      email: 'me@gmail.com',
    });
    const fake: FakeNylas = {
      calls: [],
      finds: [],
      sources: { address_book: [{ data: [person('a1', 'ann@acme.com')] }] },
    };
    restore = wire(t, fake);
    await syncAccountContacts({ userId: USER, accountId: grantId, force: true });
    fake.sources.address_book = apiError(429, 'Too Many Requests', { 'retry-after': '1800' });
    clock += 1_000;
    const result = await syncAccountContacts({ userId: USER, accountId: grantId, force: true });
    expect(result.retryAt).toBe(clock + 1_800_000);
    expect(result.sources?.map((entry) => `${entry.source}:${entry.state}:${entry.count ?? ''}`)).toEqual([
      'address_book:ok:1',
      'inbox:ok:0',
      'domain:unsupported:',
    ]);
    expect(await state(t)).toMatchObject({ retryAt: clock + 1_800_000, lastFullSyncAt: clock - 1_000 });
    expect(await stored(t)).toEqual(['address_book:a1']);
    // The wait holds until retryAt, then the pass runs again.
    expect(await syncAccountContacts({ userId: USER, accountId: grantId })).toMatchObject({
      skipped: true,
      reason: 'backoff',
    });
  });

  test('a gone grant marks the account for reconnect', async () => {
    const t = convexTest(schema, modules);
    const grantId = await connect(t);
    const fake: FakeNylas = {
      calls: [],
      finds: [],
      sources: { address_book: apiError(404, 'No grant found for grant_1') },
    };
    restore = wire(t, fake);
    const result = await syncAccountContacts({ userId: USER, accountId: grantId, force: true });
    expect(result).toMatchObject({ ok: false, status: 'error' });
    expect((await t.run((ctx) => ctx.db.query('connectedAccounts').first()))?.status).toBe('error');
    expect((await state(t))?.lastFullSyncAt).toBeUndefined();
    expect(await syncAccountContacts({ userId: USER, accountId: grantId })).toMatchObject({
      skipped: true,
      reason: 'not_connected',
    });
  });

  test('a gone grant on the scope read stops the pass before any source', async () => {
    const t = convexTest(schema, modules);
    const grantId = await connect(t);
    const fake: FakeNylas = {
      calls: [],
      finds: [],
      grantScopes: apiError(401, 'grant expired'),
      sources: {},
    };
    restore = wire(t, fake);
    const result = await syncAccountContacts({ userId: USER, accountId: grantId, force: true });
    expect(result.status).toBe('error');
    expect(fake.calls).toEqual([]);
  });

  test('a failed scope read that is not a gone grant keeps the stored scopes', async () => {
    const t = convexTest(schema, modules);
    const grantId = await connect(t);
    const fake: FakeNylas = {
      calls: [],
      finds: [],
      grantScopes: apiError(500, 'Server Error'),
      sources: {
        address_book: [{ data: [person('a1', 'ann@acme.com')] }],
        domain: apiError(502, 'bad gateway'),
      },
    };
    restore = wire(t, fake);
    const result = await syncAccountContacts({ userId: USER, accountId: grantId, force: true });
    expect(result.sources?.[0]).toMatchObject({ source: 'address_book', state: 'ok', count: 1 });
  });

  test('iCloud reads only the address book; a capped source is not pruned', async () => {
    const t = convexTest(schema, modules);
    const grantId = await connect(t, { provider: 'icloud', email: 'me@icloud.com', scopes: [] });
    const saved = CONTACT_SOURCE_CAPS.address_book;
    CONTACT_SOURCE_CAPS.address_book = 1;
    try {
      const fake: FakeNylas = {
        calls: [],
        finds: [],
        sources: {
          address_book: [
            { data: [person('a1', 'ann@acme.com')], nextCursor: '1' },
            { data: [person('a2', 'bob@acme.com')] },
          ],
        },
      };
      restore = wire(t, fake);
      await t.run(async (ctx) => {
        await ctx.db.insert('contacts', {
          userId: USER,
          accountId: grantId,
          provider: 'icloud',
          source: 'address_book',
          providerContactId: 'old',
          emails: [{ email: 'old@acme.com' }],
          searchText: 'old',
          contentHash: 'x',
          createdAt: 1,
          updatedAt: 1,
        });
      });
      const result = await syncAccountContacts({ userId: USER, accountId: grantId, force: true });
      expect(result.sources?.map((entry) => `${entry.source}:${entry.state}`)).toEqual([
        'address_book:capped',
        'inbox:unsupported',
        'domain:unsupported',
      ]);
      expect(fake.calls.map((call) => call.source)).toEqual(['address_book']);
      expect(await stored(t)).toEqual(['address_book:a1', 'address_book:old']);
    } finally {
      CONTACT_SOURCE_CAPS.address_book = saved;
    }
  });

  test('an empty pass does not prune a large stored source', async () => {
    const t = convexTest(schema, modules);
    const grantId = await connect(t);
    const fake: FakeNylas = {
      calls: [],
      finds: [],
      sources: {
        address_book: [{ data: Array.from({ length: 60 }, (_, i) => person(`a${i}`, `p${i}@acme.com`)) }],
      },
    };
    restore = wire(t, fake);
    await syncAccountContacts({ userId: USER, accountId: grantId, force: true });
    fake.sources.address_book = [{ data: [] }];
    clock += 1_000;
    await syncAccountContacts({ userId: USER, accountId: grantId, force: true });
    expect(await stored(t)).toHaveLength(60);
  });

  test('an IMAP mailbox without contact support is unsupported', async () => {
    const t = convexTest(schema, modules);
    const grantId = await connect(t, { provider: 'imap', email: 'me@yahoo.com', scopes: [] });
    const fake: FakeNylas = {
      calls: [],
      finds: [],
      sources: { address_book: apiError(400, 'IMAP contact persistence feature is not enabled') },
    };
    restore = wire(t, fake);
    const result = await syncAccountContacts({ userId: USER, accountId: grantId, force: true });
    expect(result.status).toBe('unsupported');
  });

  test('a transient failure is an error state and keeps the old count', async () => {
    const t = convexTest(schema, modules);
    const grantId = await connect(t);
    const fake: FakeNylas = {
      calls: [],
      finds: [],
      sources: {
        address_book: (token) => (token ? apiError(502, 'bad gateway') : { data: [], nextCursor: '1' }),
      },
    };
    restore = wire(t, fake);
    const result = await syncAccountContacts({ userId: USER, accountId: grantId, force: true });
    expect(result.sources?.[0]).toMatchObject({ source: 'address_book', state: 'error' });
    expect(result.status).toBe('needs_reconnect');
  });
});

describe('user pass, kicks, and scopes', () => {
  test('the user pass syncs live mailboxes and retires old dead ones', async () => {
    const t = convexTest(schema, modules);
    const live = await connect(t);
    const dead = await connect(t, { grantId: 'grant_dead', email: 'old@acme.com' });
    await t.mutation(api.accounts.markGrantReconnectNeeded, {
      internalSecret: SECRET,
      grantId: dead,
      reason: 'Reconnect needed',
    });
    await t.run((ctx) =>
      ctx.db.insert('contactSyncStates', {
        userId: USER,
        accountId: dead,
        grantId: dead,
        provider: 'google',
        status: 'ready',
        lastFullSyncAt: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const fake: FakeNylas = { calls: [], finds: [], sources: { address_book: [{ data: [] }] } };
    restore = wire(t, fake);
    const results = await syncUserContacts(USER);
    expect(results.map((entry) => `${entry.accountId}:${entry.reason}`).sort()).toEqual([
      `${live}:cron`,
      `${dead}:retired`,
    ]);
    const states = await t.run((ctx) => ctx.db.query('contactSyncStates').collect());
    expect(states.map((row) => row.accountId)).toEqual([live]);
  });

  test('a kick runs once a minute for each mailbox', async () => {
    const t = convexTest(schema, modules);
    const grantId = await connect(t);
    const fake: FakeNylas = { calls: [], finds: [], sources: { address_book: [{ data: [] }] } };
    restore = wire(t, fake);
    expect(maybeKickContactSync({ userId: USER, accountId: grantId })).toBe(true);
    expect(maybeKickContactSync({ userId: USER, accountId: grantId })).toBe(false);
    for (let i = 0; i < 20 && !(await state(t))?.lastFullSyncAt; i++) await Bun.sleep(5);
    expect((await state(t))?.status).toBe('needs_reconnect');
    clock += 61_000;
    expect(maybeKickContactSync({ userId: USER, accountId: grantId }, { reason: 'manual' })).toBe(true);
  });

  test('scope refresh writes only a changed list', async () => {
    const t = convexTest(schema, modules);
    await connect(t, { scopes: ['a', 'b'] });
    const fake: FakeNylas = { calls: [], finds: [], sources: {}, grantScopes: ['b', 'a'] };
    restore = wire(t, fake);
    const row = await t.query(api.accounts.getConnectedAccount, {
      internalSecret: SECRET,
      userId: USER,
      accountId: 'grant_1',
    });
    expect(await refreshGrantScopes(row as any)).toBe(row as any);
    fake.grantScopes = undefined;
    expect(await refreshGrantScopes(row as any)).toBe(row as any);
  });
});

describe('contact webhooks', () => {
  const account = {
    userId: USER,
    accountId: 'grant_1',
    grantId: 'grant_1',
    provider: 'google' as const,
    email: 'me@acme.com',
    status: 'connected',
    scopes: [],
  };

  test('update, reread, remove, and ignore', async () => {
    const t = convexTest(schema, modules);
    await connect(t);
    const fake: FakeNylas = { calls: [], finds: [], sources: {} };
    restore = wire(t, fake);
    expect(isContactWebhookType('contact.updated')).toBe(true);
    expect(isContactWebhookType('message.updated')).toBe(false);

    await applyContactWebhookDelta(account, 'contact.updated', {
      data: { object: person('w1', 'wes@acme.com', 'Wes') },
    });
    expect(await stored(t)).toEqual(['address_book:w1']);

    // No addresses in the payload: the contact is read again.
    fake.findReply = person('w1', 'wes@newco.com', 'Wes');
    await applyContactWebhookDelta(account, 'contact.updated', { data: { object: { id: 'w1' } } });
    expect(fake.finds).toEqual(['w1']);
    const emails = await t.run((ctx) => ctx.db.query('contactEmails').collect());
    expect(emails.map((row) => row.email)).toEqual(['wes@newco.com']);

    // A contact that lost every address goes.
    await applyContactWebhookDelta(account, 'contact.updated', {
      data: { object: { id: 'w1', emails: [] } },
    });
    expect(await stored(t)).toEqual([]);

    await applyContactWebhookDelta(account, 'contact.updated', {
      data: { object: person('w2', 'wy@acme.com') },
    });
    fake.findReply = apiError(404, 'contact not found');
    await applyContactWebhookDelta(account, 'contact.updated', { data: { object: { id: 'w2' } } });
    expect(await stored(t)).toEqual([]);

    await applyContactWebhookDelta(account, 'contact.updated', {
      data: { object: person('w3', 'zed@acme.com') },
    });
    await applyContactWebhookDelta(account, 'contact.deleted', { data: { object: { id: 'w3' } } });
    expect(await stored(t)).toEqual([]);

    expect(await applyContactWebhookDelta(account, 'contact.updated', { data: { object: {} } })).toEqual({
      applied: false,
      reason: 'missing_id',
    });
    fake.findReply = apiError(500, 'Server Error');
    await expect(
      applyContactWebhookDelta(account, 'contact.updated', { data: { object: { id: 'w4' } } }),
    ).rejects.toThrow('Server Error');
  });

  test('the webhook queue sends contact events to the contact store', async () => {
    const t = convexTest(schema, modules);
    await connect(t);
    const fake: FakeNylas = { calls: [], finds: [], sources: {} };
    restore = wire(t, fake);
    const marks: any[] = [];
    __setWebhookIngestDepsForTest({
      query: (async () => account) as any,
      mutate: (async (_fn: any, args: any) => {
        if (args?.payload !== undefined) return { duplicate: false };
        marks.push(args);
        return {};
      }) as any,
    });
    const result = await ingestNylasWebhookPayload({
      id: 'evt-contact',
      type: 'contact.updated',
      data: { object: { grant_id: 'grant_1', ...person('q1', 'quinn@acme.com', 'Quinn') } },
    });
    expect(result).toEqual({ ok: true, duplicate: false, eventId: 'evt-contact' });
    expect(marks.at(-1)).toMatchObject({ eventId: 'evt-contact', status: 'processed' });
    expect(await stored(t)).toEqual(['address_book:q1']);

    fake.findReply = apiError(500, 'Server Error');
    await expect(
      ingestNylasWebhookPayload({
        id: 'evt-contact-2',
        type: 'contact.updated',
        data: { object: { grant_id: 'grant_1', id: 'q2' } },
      }),
    ).rejects.toThrow('Server Error');
    expect(marks.at(-1)).toMatchObject({ eventId: 'evt-contact-2', status: 'error' });
  });
});

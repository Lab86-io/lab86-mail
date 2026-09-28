import { afterEach, describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { createRecipientsGet } from '../app/api/contacts/recipients/route';
import { createMobileRecipientsGet } from '../app/api/mobile/v1/contacts/recipients/route';
import { createMobileContactResyncPost } from '../app/api/mobile/v1/contacts/resync/route';
import { createMobileContactStatusGet } from '../app/api/mobile/v1/contacts/status/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import {
  __resetRecipientRateLimitForTest,
  CONTACT_STATUS_MESSAGES,
  checkRecipientRateLimit,
  loadContactStatuses,
  readExcludeParam,
  suggestRecipients,
} from '../lib/contacts/lookup';
import type { RecipientSuggestion } from '../lib/contacts/recipients';
import { contactAccountStatusV1, recipientSuggestionV1 } from '../lib/mobile/v1/contacts';
import {
  ContactStatusPageSchema,
  MobileContractV1,
  RecipientSuggestionPageSchema,
} from '../lib/mobile/v1/contract';
import { mobileOpenAPIV1 } from '../lib/mobile/v1/openapi';
import { RateLimitError } from '../lib/rate-limit';

const user = { userId: 'user_contacts', email: 'me@lab86.io', name: 'Me', source: 'clerk' as const };
const NOW = new Date('2026-09-27T22:40:00.000Z');

const suggestion = (overrides: Partial<RecipientSuggestion> = {}): RecipientSuggestion => ({
  email: 'jakob@lab86.io',
  name: 'Jakob Langtry',
  alternateEmails: ['jakob@gmail.com'],
  savedContact: true,
  directory: false,
  sources: ['addressBook', 'mail'],
  company: 'Lab86',
  photoUrl: 'https://photos.example/j.png',
  lastContactedAt: 1_790_550_000_000,
  sentCount: 42,
  receivedCount: 17,
  highlights: [
    { field: 'name', start: 0, length: 1 },
    { field: 'name', start: 6, length: 1 },
  ],
  score: 187.4,
  ...overrides,
});

afterEach(() => __resetRecipientRateLimitForTest());

describe('GET /api/mobile/v1/contacts/recipients', () => {
  function handler(overrides: Record<string, unknown> = {}) {
    const calls: any[] = [];
    const get = createMobileRecipientsGet({
      requireCurrentUser: async () => user,
      checkRateLimit: () => undefined,
      suggest: async (userId, input) => {
        calls.push({ userId, ...input });
        return {
          query: input.query,
          items: [suggestion(), suggestion({ email: 'x@y.io', name: undefined })],
        };
      },
      now: () => NOW,
      ...overrides,
    } as any);
    return { get, calls };
  }

  test('returns a strict page and passes the query, From mailbox, limit, and exclusions', async () => {
    const { get, calls } = handler();
    const response = await get(
      new Request(
        'https://mail.lab86.io/api/mobile/v1/contacts/recipients?q=%20jl%20&fromAccountID=acct_1&limit=1&exclude=A@b.io,c@d.io&exclude=e@f.io',
        { headers: { 'x-request-id': 'req-1' } },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('req-1');
    const body: any = await response.json();
    expect(RecipientSuggestionPageSchema.parse(body)).toBeTruthy();
    expect(calls).toEqual([
      {
        userId: user.userId,
        query: 'jl',
        fromAccountId: 'acct_1',
        limit: 1,
        exclude: ['a@b.io', 'c@d.io', 'e@f.io'],
      },
    ]);
    expect(body).toMatchObject({ version: 1, query: 'jl', serverTime: NOW.toISOString() });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toEqual({
      id: 'jakob@lab86.io',
      email: 'jakob@lab86.io',
      name: 'Jakob Langtry',
      alternateEmails: ['jakob@gmail.com'],
      savedContact: true,
      directory: false,
      sources: ['addressBook', 'mail'],
      company: 'Lab86',
      photoURL: 'https://photos.example/j.png',
      lastContactedAt: 1_790_550_000_000,
      sentCount: 42,
      receivedCount: 17,
      highlights: [
        { field: 'name', start: 0, length: 1 },
        { field: 'name', start: 6, length: 1 },
      ],
      score: 187.4,
    });
  });

  test('an empty query is allowed; a bad limit or a long query is a 400', async () => {
    const { get, calls } = handler();
    expect((await get(new Request('https://x/api/mobile/v1/contacts/recipients'))).status).toBe(200);
    expect(calls[0]).toMatchObject({ query: '', limit: 8, exclude: [] });
    for (const query of ['?limit=0', '?limit=11', '?limit=abc', `?q=${'a'.repeat(201)}`]) {
      const response = await get(new Request(`https://x/api/mobile/v1/contacts/recipients${query}`));
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).error.code).toBe('INVALID_REQUEST');
    }
  });

  test('sign-in and rate limits map to the error envelope', async () => {
    const signedOut = handler({
      requireCurrentUser: async () => {
        throw new AuthRequiredError('Sign in required.');
      },
    });
    expect((await signedOut.get(new Request('https://x/r'))).status).toBe(401);
    const limited = handler({
      checkRateLimit: () => {
        throw new RateLimitError('Too many requests.', 1_000, 240);
      },
    });
    const response = await limited.get(new Request('https://x/r'));
    expect(response.status).toBe(429);
    expect(((await response.json()) as any).error.retryable).toBe(true);
  });
});

describe('web recipient route', () => {
  test('returns ranked items and maps errors', async () => {
    const calls: any[] = [];
    const get = createRecipientsGet({
      requireCurrentUser: async () => user,
      checkRateLimit: () => undefined,
      suggest: async (userId: string, input: any) => {
        calls.push({ userId, ...input });
        return { query: input.query, items: [suggestion()] };
      },
    } as any);
    const response = await get(
      new Request('https://x/api/contacts/recipients?q=ja&from=acct&limit=50&exclude=a@b.io'),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      query: 'ja',
      items: [{ email: 'jakob@lab86.io' }],
    });
    expect(calls[0]).toMatchObject({ query: 'ja', fromAccountId: 'acct', limit: 10, exclude: ['a@b.io'] });

    const failing = createRecipientsGet({
      requireCurrentUser: async () => user,
      checkRateLimit: () => undefined,
      suggest: async () => {
        throw new Error('down');
      },
    } as any);
    expect((await failing(new Request('https://x/api/contacts/recipients?q=ja'))).status).toBe(500);
    const signedOut = createRecipientsGet({
      requireCurrentUser: async () => {
        throw new AuthRequiredError('Sign in required.');
      },
      checkRateLimit: () => undefined,
      suggest: async () => ({ query: '', items: [] }),
    } as any);
    expect((await signedOut(new Request('https://x/api/contacts/recipients'))).status).toBe(401);
    const limited = createRecipientsGet({
      requireCurrentUser: async () => user,
      checkRateLimit: () => {
        throw new RateLimitError('Too many requests.', 1_000, 240);
      },
      suggest: async () => ({ query: '', items: [] }),
    } as any);
    expect((await limited(new Request('https://x/api/contacts/recipients'))).status).toBe(429);
  });
});

describe('GET /api/mobile/v1/contacts/status', () => {
  test('maps each mailbox to the strict status shape', async () => {
    const get = createMobileContactStatusGet({
      requireCurrentUser: async () => user,
      loadContactStatuses: async () => [
        {
          accountId: 'acct_1',
          email: 'me@lab86.io',
          provider: 'google',
          state: 'needsReconnect',
          needsReconnect: true,
          contactCount: 3,
          lastSyncedAt: 1_790_550_000_000,
          sources: [
            { source: 'address_book', state: 'missing_scope' },
            { source: 'domain', state: 'ok', count: 3 },
          ],
          message: CONTACT_STATUS_MESSAGES.needsReconnect,
        },
      ],
      now: () => NOW,
    });
    const response = await get(new Request('https://x/api/mobile/v1/contacts/status'));
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(ContactStatusPageSchema.parse(body)).toBeTruthy();
    expect(body.accounts[0]).toEqual({
      accountID: 'acct_1',
      email: 'me@lab86.io',
      provider: 'google',
      state: 'needsReconnect',
      needsReconnect: true,
      contactCount: 3,
      lastSyncedAt: 1_790_550_000_000,
      sources: [
        { source: 'addressBook', state: 'missingScope' },
        { source: 'domain', state: 'ok', count: 3 },
      ],
      message: 'Reconnect this mailbox to add its contacts.',
    });
    const failing = createMobileContactStatusGet({
      requireCurrentUser: async () => user,
      loadContactStatuses: async () => {
        throw new Error('down');
      },
      now: () => NOW,
    });
    expect((await failing(new Request('https://x/s'))).status).toBe(500);
  });
});

describe('POST /api/mobile/v1/contacts/resync', () => {
  const accounts = [
    { accountId: 'acct_1', status: 'connected' },
    { accountId: 'acct_2', status: 'error' },
  ] as any[];
  function handler() {
    const kicks: any[] = [];
    const post = createMobileContactResyncPost({
      requireCurrentUser: async () => user,
      enforceUserRateLimit: async () => undefined as any,
      listAccounts: async () => accounts,
      kick: ((row: any, options: any) => {
        kicks.push({ ...row, ...options });
        return false;
      }) as any,
    });
    return { post, kicks };
  }
  const request = (body: unknown) =>
    new Request('https://x/api/mobile/v1/contacts/resync', { method: 'POST', body: JSON.stringify(body) });

  test('starts a pass for a connected mailbox and reports a debounced one', async () => {
    const { post, kicks } = handler();
    const response = await post(request({ accountID: 'acct_1' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accountID: 'acct_1', started: false });
    expect(kicks).toEqual([
      { userId: user.userId, accountId: 'acct_1', force: true, reason: 'mobile_resync' },
    ]);
  });

  test('unknown, paused, and malformed requests', async () => {
    const { post, kicks } = handler();
    expect((await post(request({ accountID: 'nope' }))).status).toBe(404);
    expect((await post(request({ accountID: 'acct_2' }))).status).toBe(409);
    expect((await post(request({ accountId: 'acct_1' }))).status).toBe(400);
    expect(kicks).toEqual([]);
  });
});

describe('contact services', () => {
  test('recipient search passes a clean query to Convex', async () => {
    const calls: any[] = [];
    const result = await suggestRecipients(
      'user_1',
      { query: 'ann', fromAccountId: 'acct', limit: 5, exclude: ['a@b.io'] },
      (async (_fn: any, args: any) => {
        calls.push(args);
        return { query: 'ann', items: [suggestion()] };
      }) as any,
    );
    expect(result.items).toHaveLength(1);
    expect(calls[0]).toEqual({
      userId: 'user_1',
      query: 'ann',
      fromAccountId: 'acct',
      limit: 5,
      exclude: ['a@b.io'],
    });
    const empty = await suggestRecipients('user_1', { query: '' }, (async () => null) as any);
    expect(empty).toEqual({ query: '', items: [] });
  });

  test('the in-memory limit allows 240 searches a minute', () => {
    for (let i = 0; i < 240; i++) checkRecipientRateLimit('user_rl', 1_000);
    expect(() => checkRecipientRateLimit('user_rl', 1_000)).toThrow('Too many requests');
    expect(() => checkRecipientRateLimit('user_rl', 61_000)).not.toThrow();
    expect(readExcludeParam(['A@b.io, ,c@d.io', 'e@f.io'])).toEqual(['a@b.io', 'c@d.io', 'e@f.io']);
  });

  test('contact status comes from stored state and, before a pass, from the stored scopes', async () => {
    const G = 'https://www.googleapis.com/auth/';
    const accounts = [
      {
        accountId: 'a_ready',
        email: 'a@acme.com',
        provider: 'google',
        status: 'connected',
        scopes: [],
        updatedAt: 1,
      },
      {
        accountId: 'a_missing',
        email: 'b@gmail.com',
        provider: 'google',
        status: 'connected',
        scopes: ['openid'],
      },
      { accountId: 'a_icloud', email: 'c@icloud.com', provider: 'icloud', status: 'connected', scopes: [] },
      { accountId: 'a_dead', email: 'd@acme.com', provider: 'google', status: 'error', scopes: [] },
      { accountId: 'a_gone', email: 'e@acme.com', provider: 'google', status: 'disconnected', scopes: [] },
      {
        accountId: 'a_reconnected',
        email: 'f@acme.com',
        provider: 'google',
        status: 'connected',
        scopes: [`${G}contacts.readonly`, `${G}contacts.other.readonly`, `${G}directory.readonly`],
        updatedAt: 500,
      },
      { accountId: 'a_syncing', email: 'g@acme.com', provider: 'google', status: 'connected', scopes: [] },
      { accountId: 'a_unsupported', email: 'h@yahoo.com', provider: 'imap', status: 'connected', scopes: [] },
      { accountId: 'a_error', email: 'i@acme.com', provider: 'google', status: 'connected', scopes: [] },
      { accountId: 'a_idle', email: 'j@acme.com', provider: 'google', status: 'connected', scopes: [] },
    ];
    const states = [
      {
        accountId: 'a_ready',
        status: 'ready',
        sources: [{ source: 'address_book', state: 'ok', count: 12 }],
        contactCount: 12,
        lastFullSyncAt: 99,
      },
      { accountId: 'a_reconnected', status: 'needs_reconnect', sources: [], lastAttemptAt: 100 },
      { accountId: 'a_syncing', status: 'ready', sources: [], syncing: true },
      { accountId: 'a_unsupported', status: 'unsupported', sources: [] },
      { accountId: 'a_error', status: 'error', sources: [] },
      { accountId: 'a_idle', status: 'idle', sources: [] },
    ];
    const statuses = await loadContactStatuses('user_1', (async (fn: any) =>
      getFunctionName(fn) === 'contacts:listContactStates' ? states : accounts) as any);
    const byId = Object.fromEntries(statuses.map((entry) => [entry.accountId, entry]));
    expect(Object.keys(byId)).not.toContain('a_gone');
    expect(byId.a_ready).toMatchObject({
      state: 'ready',
      needsReconnect: false,
      contactCount: 12,
      lastSyncedAt: 99,
      sources: [{ source: 'address_book', state: 'ok', count: 12 }],
    });
    expect(byId.a_ready.message).toBeUndefined();
    // No pass yet, and the stored scopes lack every contact scope.
    expect(byId.a_missing).toMatchObject({
      state: 'needsReconnect',
      needsReconnect: true,
      sources: [
        { source: 'address_book', state: 'missing_scope' },
        { source: 'inbox', state: 'missing_scope' },
        { source: 'domain', state: 'unsupported' },
      ],
    });
    expect(byId.a_icloud).toMatchObject({
      state: 'pending',
      sources: [
        { source: 'inbox', state: 'unsupported' },
        { source: 'domain', state: 'unsupported' },
      ],
    });
    expect(byId.a_dead).toMatchObject({ state: 'paused', message: 'This mailbox needs to sign in again.' });
    expect(byId.a_reconnected.state).toBe('pending');
    expect(byId.a_syncing.state).toBe('syncing');
    expect(byId.a_unsupported.state).toBe('unsupported');
    expect(byId.a_error.state).toBe('error');
    expect(byId.a_idle.state).toBe('pending');
    // A later pass that still lacks the scope keeps the reconnect state.
    const stale = await loadContactStatuses('user_1', (async (fn: any) =>
      getFunctionName(fn) === 'contacts:listContactStates'
        ? [{ accountId: 'a_missing', status: 'needs_reconnect', sources: [], lastAttemptAt: 10 }]
        : accounts.filter((row) => row.accountId === 'a_missing')) as any);
    expect(stale[0].state).toBe('needsReconnect');
    const noStates = await loadContactStatuses('user_1', (async (fn: any) => {
      if (getFunctionName(fn) === 'contacts:listContactStates') throw new Error('down');
      return null;
    }) as any);
    expect(noStates).toEqual([]);
  });
});

describe('contract', () => {
  test('the published schemas and paths exist', () => {
    const document: any = mobileOpenAPIV1();
    expect(document.paths['/api/mobile/v1/contacts/recipients'].get.operationId).toBe(
      'getMobileRecipientSuggestions',
    );
    expect(document.paths['/api/mobile/v1/contacts/status'].get.operationId).toBe('getMobileContactStatus');
    expect(document.paths['/api/mobile/v1/contacts/resync'].post.operationId).toBe('postMobileContactResync');
    for (const name of [
      'RecipientSuggestionPage',
      'RecipientSuggestion',
      'ContactStatusPage',
      'ContactAccountStatus',
      'ContactResyncReceipt',
    ]) {
      expect(document.components.schemas[name]).toBeDefined();
      expect(name in MobileContractV1.schemas).toBe(true);
    }
  });

  test('mappers drop bad highlights, non-https photos, and empty text', () => {
    const mapped = recipientSuggestionV1(
      suggestion({
        name: '  ',
        alternateEmails: [],
        photoUrl: 'http://insecure.example/p.png',
        highlights: [
          { field: 'name', start: 0, length: 1 },
          { field: 'email', start: 0, length: 400 },
          { field: 'email', start: 0, length: 5 },
        ],
        score: Number.NaN,
        lastContactedAt: undefined,
      }),
    );
    expect(mapped.name).toBeUndefined();
    expect(mapped.alternateEmails).toBeUndefined();
    expect(mapped.photoURL).toBeUndefined();
    expect(mapped.highlights).toEqual([{ field: 'email', start: 0, length: 5 }]);
    expect(mapped.score).toBe(0);
    expect(recipientSuggestionV1(suggestion({ photoUrl: 'not a url' })).photoURL).toBeUndefined();
    const status = contactAccountStatusV1({
      accountId: 'a',
      email: 'a@b.io',
      provider: 'icloud',
      state: 'ready',
      needsReconnect: false,
      contactCount: 2,
      sources: [{ source: 'address_book', state: 'capped', count: 2.7 }],
    });
    expect(status).toEqual({
      accountID: 'a',
      email: 'a@b.io',
      provider: 'icloud',
      state: 'ready',
      needsReconnect: false,
      contactCount: 2,
      sources: [{ source: 'addressBook', state: 'capped', count: 2 }],
    });
  });
});

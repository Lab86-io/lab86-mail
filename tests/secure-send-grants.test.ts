import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { mailDomainLine, secureUseLine } from '../lib/albatross/secure-view';
import type { SecureItemView } from '../lib/secure/contract';
import { findReferences } from '../lib/secure/policy';
import { createSecureDetailsRoutes, secureRouteDefaults } from '../lib/secure/routes';
import { createSecureRunAccess, SecureNeedsAllow } from '../lib/secure/runner-access';
import {
  allowSecureSend,
  consumeSendGrants,
  SEND_GRANT_TTL_MS,
  sendGrantCovers,
  sendGrantDeps,
  sendTokenHash,
  sendTokenValid,
} from '../lib/secure/send-grants';
import {
  normalizeMailDomains,
  type OpenedItem,
  secureStoreDeps,
  updateSecureItem,
} from '../lib/secure/store';

// Send grants (docs/albatross-goal-runs.md G5, lead decision 2026-10-15): a
// mail domain and a website are different permissions. Invented data only.

const SECRET = 'send-grant-secret';
const userId = 'send_user';
const caller = { internalSecret: SECRET, userId };
const ITEM = 'si_ssnaaaaaaaaaaaaaaaaaaa';
const SEND = 'outbox:00000000-0000-4000-8000-000000000001';
const OTHER_SEND = 'outbox:00000000-0000-4000-8000-000000000002';
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});
const originalGrantDeps = { ...sendGrantDeps };
const originalStoreDeps = { ...secureStoreDeps };
afterEach(() => {
  Object.assign(sendGrantDeps, originalGrantDeps);
  Object.assign(secureStoreDeps, originalStoreDeps);
});

const harness = () =>
  convexTest(schema, {
    '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
    '../convex/secureDetails.ts': () => import('../convex/secureDetails'),
  });

function createItem(t: ReturnType<typeof harness>) {
  return t.mutation(api.secureDetails.createItem, {
    ...caller,
    itemId: ITEM,
    kind: 'id_number',
    label: 'Social Security number',
    sites: ['irs.gov'],
    hints: [{ field: 'number', hint: 'ends 3456' }],
    facts: [{ name: 'type', value: 'ssn' }],
    sealed: { payloadSealed: 'sv1.aaaa.bbbb.cccc', dataKeyWrapped: 'sv1.dddd.eeee.ffff', kekId: 's1' },
  });
}

const view = (overrides: Partial<SecureItemView> = {}): SecureItemView => ({
  id: ITEM,
  kind: 'id_number',
  label: 'Social Security number',
  sites: [],
  mailDomains: [],
  hints: { number: 'ends 3456' },
  facts: { type: 'ssn' },
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  ...overrides,
});

describe('send grants in Convex', () => {
  test('"Allow for this send" is bound to one send key, works one time, and ends', async () => {
    const t = harness();
    await createItem(t);
    const tokenHash = sendTokenHash('tok');
    const grant = (overrides: Record<string, unknown> = {}) =>
      t.mutation(api.secureDetails.grantSendOnce, {
        ...caller,
        sendKey: SEND,
        tokenHash,
        grants: [{ itemId: ITEM, domain: 'example.com' }],
        ttlMs: SEND_GRANT_TTL_MS,
        ...overrides,
      });
    const granted = await grant();
    expect(granted.granted).toBe(true);
    await expect(grant({ sendKey: 'nope' })).rejects.toThrow(/send key/);
    await expect(grant({ tokenHash: 'short' })).rejects.toThrow(/token/);
    await expect(grant({ grants: [] })).rejects.toThrow(/grants/);
    expect(
      await grant({ grants: [{ itemId: 'si_missing0000000000000000', domain: 'example.com' }] }),
    ).toEqual({
      granted: false,
    });
    const valid = (hash: string, sendKey: string) =>
      t.query(api.secureDetails.sendTokenValid, { ...caller, tokenHash: hash, sendKey });
    expect(await valid(tokenHash, SEND)).toBe(true);
    expect(await valid(tokenHash, OTHER_SEND)).toBe(false);
    expect(await valid(sendTokenHash('other'), SEND)).toBe(false);
    expect(await valid('bad', SEND)).toBe(false);
    const covers = (domain: string, sendKey = SEND) =>
      t.query(api.secureDetails.sendGrantCovers, { ...caller, itemId: ITEM, domain, sendKey });
    expect(await covers('example.com')).toBe(true);
    expect(await covers('example.org')).toBe(false);
    expect(await covers('example.com', OTHER_SEND)).toBe(false);
    // A send grant is not a site: a run on example.com pages gets no "Allow once" from it.
    expect(
      await t.query(api.secureDetails.hasGrant, {
        ...caller,
        itemId: ITEM,
        site: 'example.com',
        workId: 'w',
        stepKey: 's',
      }),
    ).toBe(false);
    // Single use.
    expect(await t.mutation(api.secureDetails.consumeSendGrants, { ...caller, sendKey: SEND })).toEqual({
      used: 1,
    });
    expect(await covers('example.com')).toBe(false);
    expect(await valid(tokenHash, SEND)).toBe(false);
    expect(await t.mutation(api.secureDetails.consumeSendGrants, { ...caller, sendKey: SEND })).toEqual({
      used: 0,
    });
    // A new value ends every "Allow for this send"; deleting the item ends the rest.
    await grant({ sendKey: OTHER_SEND });
    await t.mutation(api.secureDetails.updateItem, {
      ...caller,
      itemId: ITEM,
      sealed: { payloadSealed: 'sv1.zzzz.bbbb.cccc', dataKeyWrapped: 'sv1.dddd.eeee.ffff', kekId: 's1' },
    });
    expect(await covers('example.com', OTHER_SEND)).toBe(false);
    await grant({ sendKey: OTHER_SEND });
    await t.mutation(api.secureDetails.deleteItem, { ...caller, itemId: ITEM });
    expect(await t.run((ctx) => ctx.db.query('secureSendGrants').collect())).toEqual([]);
  });

  test('"Always for mail to" keeps mail domains apart from sites', async () => {
    const t = harness();
    await createItem(t);
    expect(
      await t.mutation(api.secureDetails.addMailDomains, {
        ...caller,
        itemId: ITEM,
        domains: ['example.com', 'example.com', 'example.org'],
      }),
    ).toEqual({ added: 2 });
    expect(
      await t.mutation(api.secureDetails.addMailDomains, {
        ...caller,
        itemId: ITEM,
        domains: ['example.com'],
      }),
    ).toEqual({ added: 0 });
    expect(
      await t.mutation(api.secureDetails.addMailDomains, {
        ...caller,
        itemId: 'si_missing0000000000000000',
        domains: ['example.com'],
      }),
    ).toEqual({ added: 0 });
    const [item] = await t.query(api.secureDetails.listItems, caller);
    expect(item.mailDomains).toEqual(['example.com', 'example.org']);
    expect(item.sites).toEqual(['irs.gov']);
    await t.mutation(api.secureDetails.updateItem, { ...caller, itemId: ITEM, mailDomains: ['example.org'] });
    expect((await t.query(api.secureDetails.listItems, caller))[0].mailDomains).toEqual(['example.org']);
    await expect(
      t.mutation(api.secureDetails.updateItem, { ...caller, itemId: ITEM, mailDomains: ['not a domain'] }),
    ).rejects.toThrow(/Invalid site/);
  });
});

describe('allowSecureSend', () => {
  function fake(items: SecureItemView[] = [view()]) {
    const mutations: Array<{ name: string; args: any }> = [];
    const uses: any[] = [];
    Object.assign(sendGrantDeps, {
      listItems: async () => items,
      mutation: async (ref: any, args: any) => {
        mutations.push({ name: getFunctionName(ref), args });
        return getFunctionName(ref) === 'secureDetails:grantSendOnce'
          ? { granted: true, expiresAt: 99 }
          : { added: 1 };
      },
      query: async () => true,
      recordUse: async (use: any) => {
        uses.push(use);
      },
      newToken: () => 'token_1',
    });
    return { mutations, uses };
  }

  test('once gives a token for this send; always adds the mail domains', async () => {
    const { mutations, uses } = fake();
    const once = await allowSecureSend(userId, {
      sendId: SEND,
      scope: 'once',
      items: [{ itemId: ITEM, domains: ['ap@billing.example.com', 'example.com'] }],
    });
    expect(once).toEqual({ ok: true, scope: 'once', allowToken: 'token_1', expiresAt: 99 });
    expect(mutations[0]).toEqual({
      name: 'secureDetails:grantSendOnce',
      args: {
        userId,
        sendKey: SEND,
        tokenHash: sendTokenHash('token_1'),
        grants: [{ itemId: ITEM, domain: 'example.com' }],
        ttlMs: SEND_GRANT_TTL_MS,
      },
    });
    expect(uses).toEqual([{ userId, itemId: ITEM, outcome: 'allowed_send_once', site: 'example.com' }]);
    const always = await allowSecureSend(userId, {
      sendId: SEND,
      scope: 'always',
      items: [{ itemId: ITEM, domains: ['example.org'] }],
    });
    expect(always).toEqual({ ok: true, scope: 'always' });
    expect(mutations[1]).toEqual({
      name: 'secureDetails:addMailDomains',
      args: { userId, itemId: ITEM, domains: ['example.org'] },
    });
    expect(uses[1]).toEqual({ userId, itemId: ITEM, outcome: 'allowed_send_always', site: 'example.org' });
  });

  test('refuses a bad send id, a gone item, a sign-in, a private domain, and a lost grant', async () => {
    fake([view(), view({ id: 'si_chase000000000000000000', kind: 'sign_in', label: 'Chase' })]);
    const ask = (body: Partial<Parameters<typeof allowSecureSend>[1]>) =>
      allowSecureSend(userId, {
        sendId: SEND,
        scope: 'once',
        items: [{ itemId: ITEM, domains: ['example.com'] }],
        ...body,
      });
    await expect(ask({ sendId: 'outbox:nope' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      ask({ items: [{ itemId: 'si_missing0000000000000000', domains: ['example.com'] }] }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      ask({ items: [{ itemId: 'si_chase000000000000000000', domains: ['chase.com'] }] }),
    ).rejects.toThrow('Only an ID number or a date of birth goes in a mail.');
    await expect(ask({ items: [{ itemId: ITEM, domains: ['localhost'] }] })).rejects.toMatchObject({
      code: 'site',
    });
    await expect(ask({ items: [{ itemId: ITEM, domains: [] }] })).rejects.toMatchObject({ code: 'site' });
    sendGrantDeps.mutation = (async () => ({ granted: false })) as any;
    await expect(ask({})).rejects.toMatchObject({ code: 'not_found' });
  });

  test('token check, cover check, and use go to Convex; a failed read is no grant', async () => {
    const calls: any[] = [];
    const deps = {
      query: async (ref: any, args: any) => {
        calls.push([getFunctionName(ref), args]);
        return true;
      },
      mutation: async (ref: any, args: any) => {
        calls.push([getFunctionName(ref), args]);
        return { used: 1 };
      },
    } as any;
    expect(await sendTokenValid(userId, 'tok', SEND, deps)).toBe(true);
    expect(calls[0]).toEqual([
      'secureDetails:sendTokenValid',
      { userId, tokenHash: sendTokenHash('tok'), sendKey: SEND },
    ]);
    expect(await sendTokenValid(userId, '', SEND, deps)).toBe(false);
    expect(await sendTokenValid(userId, 'tok', 'outbox:x', deps)).toBe(false);
    expect(await sendGrantCovers({ userId, itemId: ITEM, domain: 'example.com', sendKey: SEND }, deps)).toBe(
      true,
    );
    await consumeSendGrants(userId, SEND, deps);
    expect(calls.at(-1)).toEqual(['secureDetails:consumeSendGrants', { userId, sendKey: SEND }]);
    const failing = {
      query: async () => {
        throw new Error('Convex down');
      },
    } as any;
    expect(await sendTokenValid(userId, 'tok', SEND, failing)).toBe(false);
    expect(
      await sendGrantCovers({ userId, itemId: ITEM, domain: 'example.com', sendKey: SEND }, failing),
    ).toBe(false);
  });
});

describe('POST /api/secure-details/allow-send', () => {
  const request = (body: unknown) =>
    new Request('https://mail.lab86.io/api/secure-details/allow-send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const body = { sendId: SEND, scope: 'once', items: [{ itemId: ITEM, domains: ['example.com'] }] };
  const routes = (overrides: Partial<typeof secureRouteDefaults> = {}) => {
    const calls: any[] = [];
    const deps = {
      ...secureRouteDefaults,
      requireCurrentUser: async () => ({
        userId,
        email: 'sam@example.com',
        name: 'Sam',
        source: 'clerk' as const,
      }),
      enforceUserRateLimit: async () => ({ ok: true }) as any,
      enabled: () => true,
      identityChecked: async () => true,
      allowSecureSend: async (...args: any[]) => {
        calls.push(args);
        return { ok: true as const, scope: 'once' as const, allowToken: 'token_1', expiresAt: 99 };
      },
      ...overrides,
    } as typeof secureRouteDefaults;
    return { routes: createSecureDetailsRoutes(deps), calls };
  };

  test('both scopes need the identity check first', async () => {
    const { routes: unchecked, calls } = routes({ identityChecked: async () => false });
    const refused = await unchecked.allowSend(request(body));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'verify_identity' });
    expect(calls).toEqual([]);
    const { routes: checked, calls: made } = routes();
    const ok = await checked.allowSend(request(body));
    expect(await ok.json()).toEqual({ ok: true, scope: 'once', allowToken: 'token_1', expiresAt: 99 });
    expect(made).toEqual([[userId, body]]);
    expect(ok.headers.get('cache-control')).toBe('no-store');
  });

  test('a bad body, a store that is off', async () => {
    expect((await routes().routes.allowSend(request({ ...body, sendId: 'x' }))).status).toBe(400);
    expect((await routes().routes.allowSend(request({ ...body, items: [] }))).status).toBe(400);
    expect((await routes({ enabled: () => false }).routes.allowSend(request(body))).status).toBe(404);
  });
});

describe('mail domains on an item', () => {
  test('adding a mail domain needs the check; removing one does not', async () => {
    const row = {
      itemId: ITEM,
      kind: 'id_number',
      label: 'Social Security number',
      sites: [],
      mailDomains: ['example.org'],
      hints: [{ field: 'number', hint: 'ends 3456' }],
      facts: [{ name: 'type', value: 'ssn' }],
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      payloadSealed: 'x',
      dataKeyWrapped: 'y',
      kekId: 'k',
    };
    const updates: any[] = [];
    Object.assign(secureStoreDeps, {
      enabled: () => true,
      query: async () => [row],
      mutation: async (_ref: any, args: any) => {
        updates.push(args);
        return { updated: true };
      },
    });
    await expect(
      updateSecureItem(
        userId,
        ITEM,
        { mailDomains: ['example.org', 'example.com'] },
        { identityChecked: false },
      ),
    ).rejects.toMatchObject({ code: 'verify_identity' });
    const added = await updateSecureItem(
      userId,
      ITEM,
      { mailDomains: ['example.org', 'ap@billing.example.com'] },
      { identityChecked: true },
    );
    expect(added.mailDomains).toEqual(['example.org', 'example.com']);
    expect(updates[0]).toEqual({ userId, itemId: ITEM, mailDomains: ['example.org', 'example.com'] });
    const removed = await updateSecureItem(userId, ITEM, { mailDomains: [] }, { identityChecked: false });
    expect(removed.mailDomains).toEqual([]);
    expect(normalizeMailDomains(['Example.COM', 'x@example.com'])).toEqual(['example.com']);
    expect(() =>
      normalizeMailDomains(
        Array.from({ length: 21 }, (_, index) => `d${index}.example.com`).map((d, i) => `${i}${d}`),
      ),
    ).not.toThrow();
    expect(() => normalizeMailDomains(Array.from({ length: 21 }, (_, index) => `site${index}.com`))).toThrow(
      'mail domains at most',
    );
  });
});

describe('the two permissions never cross', () => {
  test('a mail domain never lets a run type the value on that site', async () => {
    const uses: any[] = [];
    const run = createSecureRunAccess({
      userId,
      runId: 'run_1',
      workId: 'work_1',
      stepKey: 'step_1',
      log: async () => undefined,
      deps: {
        openItems: async () =>
          [{ item: view({ mailDomains: ['example.com'] }), values: { number: '123456789' } }] as OpenedItem[],
        recordUse: async (use: any) => {
          uses.push(use);
        },
        hasGrant: async () => false,
      },
    });
    await expect(
      run.resolveForField({
        reference: findReferences(`{{secure:${ITEM}.number}}`)[0],
        fieldUrl: 'https://forms.example.com/w9',
        fieldKind: 'plain',
      }),
    ).rejects.toBeInstanceOf(SecureNeedsAllow);
    expect(uses.map((use) => use.outcome)).toEqual(['asked']);
  });

  test('Settings shows send grants in plain words', () => {
    expect(mailDomainLine('statpearls.com')).toBe('Mail to statpearls.com');
    const use = { field: 'number', site: 'statpearls.com' };
    expect(secureUseLine({ ...use, outcome: 'allowed_send_once' }, 'id_number')).toBe(
      'You allowed it in mail to statpearls.com for one send',
    );
    expect(secureUseLine({ ...use, outcome: 'allowed_send_always' }, 'id_number')).toBe(
      'You allowed it in mail to statpearls.com from now on',
    );
    expect(secureUseLine({ ...use, outcome: 'sent' }, 'id_number')).toBe('Sent to statpearls.com');
  });
});

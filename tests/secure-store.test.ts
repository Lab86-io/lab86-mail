import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { secureFetchDeps } from '../lib/secure/fetch';
import { secureStoreEnabledFor, secureStoreFlagFor } from '../lib/secure/flag';
import { SecurePolicyError } from '../lib/secure/policy';
import {
  createSecureItem,
  deleteSecureItem,
  listSecureItems,
  listSecureUses,
  openSecureItems,
  recordSecureUse,
  SecureStoreError,
  secureInventory,
  secureStoreDeps,
  updateSecureItem,
} from '../lib/secure/store';

// The server store for Passwords and IDs (docs/albatross-secure-store.md),
// against a fake Convex that keeps rows in memory.

void secureFetchDeps;
const original = { ...secureStoreDeps };
const envBefore = { kek: process.env.LAB86_SECURE_KEK, flag: process.env.LAB86_SECURE_STORE };
afterEach(() => {
  Object.assign(secureStoreDeps, original);
  process.env.LAB86_SECURE_KEK = envBefore.kek;
  process.env.LAB86_SECURE_STORE = envBefore.flag;
  if (envBefore.kek === undefined) delete process.env.LAB86_SECURE_KEK;
  if (envBefore.flag === undefined) delete process.env.LAB86_SECURE_STORE;
});

const join = (...parts: string[]) => parts.join('');
const NOW = Date.UTC(2026, 9, 8);

function fakeConvex() {
  const rows: any[] = [];
  const calls: Array<{ name: string; args: any }> = [];
  let next = 0;
  const query = (async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    const mine = rows.filter((row) => row.userId === args.userId);
    if (name === 'secureDetails:listItems')
      return mine.map(({ payloadSealed: _p, dataKeyWrapped: _d, kekId: _k, ...view }) => view);
    if (name === 'secureDetails:listSealed') return mine;
    if (name === 'secureDetails:listUses')
      return [
        {
          id: 'u1',
          itemId: args.itemId,
          field: 'number',
          site: 'ny.gov',
          host: 'dmv.ny.gov',
          workId: 'w1',
          workTitle: 'Renew the car registration',
          runId: 'r1',
          outcome: 'typed',
          at: 5,
        },
      ];
    throw new Error(`unexpected query ${name}`);
  }) as any;
  const mutation = (async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    if (name === 'secureDetails:createItem') {
      rows.push({
        userId: args.userId,
        itemId: args.itemId,
        kind: args.kind,
        label: args.label,
        sites: args.sites,
        hints: args.hints,
        facts: args.facts,
        ...args.sealed,
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
      });
      return { itemId: args.itemId };
    }
    if (name === 'secureDetails:updateItem') {
      const row = rows.find((entry) => entry.userId === args.userId && entry.itemId === args.itemId);
      if (!row) return { updated: false };
      for (const field of ['label', 'sites', 'hints', 'facts'])
        if (args[field] !== undefined) row[field] = args[field];
      if (args.sealed) Object.assign(row, args.sealed);
      return { updated: true };
    }
    if (name === 'secureDetails:deleteItem') {
      const index = rows.findIndex((entry) => entry.userId === args.userId && entry.itemId === args.itemId);
      if (index < 0) return { deleted: false };
      rows.splice(index, 1);
      return { deleted: true };
    }
    if (name === 'secureDetails:recordUse') return { recorded: true };
    throw new Error(`unexpected mutation ${name}`);
  }) as any;
  Object.assign(secureStoreDeps, {
    query,
    mutation,
    enabled: () => true,
    newId: () => `si_${String(next++).padStart(22, '0')}`,
    now: () => NOW,
  });
  return { rows, calls };
}

function withKey() {
  process.env.LAB86_SECURE_KEK = randomBytes(32).toString('base64');
}

describe('flag', () => {
  test('all, a list of ids, or off; the key is required too', () => {
    expect(secureStoreFlagFor('user_1', 'all')).toBe(true);
    expect(secureStoreFlagFor('user_1', ' user_2, user_1 ')).toBe(true);
    expect(secureStoreFlagFor('user_3', 'user_2,user_1')).toBe(false);
    expect(secureStoreFlagFor('user_1', '')).toBe(false);
    expect(secureStoreFlagFor('', 'all')).toBe(false);
    process.env.LAB86_SECURE_STORE = 'user_1';
    delete process.env.LAB86_SECURE_KEK;
    expect(secureStoreEnabledFor('user_1')).toBe(false);
    process.env.LAB86_SECURE_KEK = 'not a key';
    expect(secureStoreEnabledFor('user_1')).toBe(false);
    withKey();
    expect(secureStoreEnabledFor('user_1')).toBe(true);
    expect(secureStoreEnabledFor('user_2')).toBe(false);
  });
});

describe('secure store', () => {
  test('create seals the values; the list and the views never hold one', async () => {
    withKey();
    const { rows } = fakeConvex();
    const item = await createSecureItem('user_1', {
      kind: 'sign_in',
      label: 'Chase',
      sites: ['https://secure.chase.com/login'],
      values: { username: 'sam.rivera@example.com', password: join('hunter', '22') },
    });
    expect(item).toMatchObject({
      id: 'si_0000000000000000000000',
      label: 'Chase',
      sites: ['chase.com'],
      hints: { username: 's•••@example.com', password: '••••••••' },
    });
    expect(JSON.stringify(rows)).not.toContain('hunter22');
    expect(JSON.stringify(await listSecureItems('user_1'))).not.toContain('hunter22');
    expect((await openSecureItems('user_1'))[0].values.password).toBe('hunter22');
  });

  test('a sign-in or a key needs a site; one date of birth only; the limit and the flag hold', async () => {
    withKey();
    fakeConvex();
    await expect(
      createSecureItem('user_1', { kind: 'sign_in', values: { username: 'a', password: 'b' } }),
    ).rejects.toThrow(/site, for example chase.com/);
    await expect(
      createSecureItem('user_1', { kind: 'api_key', values: { key: 'abcdefghijklmnopqrstu' } }),
    ).rejects.toThrow(/api.openai.com/);
    await expect(createSecureItem('user_1', { kind: 'bogus' as any, values: {} })).rejects.toBeInstanceOf(
      SecurePolicyError,
    );
    await createSecureItem('user_1', { kind: 'date_of_birth', values: { date: '1990-04-02' } });
    await expect(
      createSecureItem('user_1', { kind: 'date_of_birth', values: { date: '1991-04-02' } }),
    ).rejects.toThrow(/date of birth is saved/);
    secureStoreDeps.enabled = () => false;
    await expect(listSecureItems('user_1')).rejects.toBeInstanceOf(SecureStoreError);
    expect(await openSecureItems('user_1')).toEqual([]);
    expect(await secureInventory('user_1')).toEqual([]);
  });

  test('a new site needs the identity check; removing one does not', async () => {
    withKey();
    fakeConvex();
    const id = (
      await createSecureItem('user_1', {
        kind: 'id_number',
        values: { type: 'drivers_license', number: 'D1234821' },
      })
    ).id;
    await expect(
      updateSecureItem('user_1', id, { sites: ['dmv.ny.gov'] }, { identityChecked: false }),
    ).rejects.toMatchObject({
      code: 'verify_identity',
    });
    const added = await updateSecureItem('user_1', id, { sites: ['dmv.ny.gov'] }, { identityChecked: true });
    expect(added.sites).toEqual(['ny.gov']);
    expect((await updateSecureItem('user_1', id, { sites: [] }, { identityChecked: false })).sites).toEqual(
      [],
    );
    const chase = (
      await createSecureItem('user_1', {
        kind: 'sign_in',
        sites: ['chase.com'],
        values: { username: 'a', password: 'b' },
      })
    ).id;
    await expect(updateSecureItem('user_1', chase, { sites: [] }, { identityChecked: true })).rejects.toThrow(
      /at least one site/,
    );
    await expect(
      updateSecureItem('user_1', 'si_missing000000000000000', { label: 'x' }, { identityChecked: true }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  test('a replace changes only the named field, keeps the facts, and can clear an optional field', async () => {
    withKey();
    const { rows } = fakeConvex();
    const id = (
      await createSecureItem('user_1', {
        kind: 'id_number',
        values: { type: 'drivers_license', number: 'D1234821', region: 'NY', expires: '2029-06-30' },
      })
    ).id;
    const before = rows[0].payloadSealed;
    const replaced = await updateSecureItem(
      'user_1',
      id,
      { values: { number: 'D9998888', expires: null } },
      { identityChecked: false },
    );
    expect(replaced.hints.number).toBe('ends 8888');
    expect(replaced.facts).toEqual({ type: 'drivers_license', region: 'NY' });
    expect(rows[0].payloadSealed).not.toBe(before);
    expect((await openSecureItems('user_1'))[0].values).toEqual({ number: 'D9998888' });
    const renamed = await updateSecureItem('user_1', id, { label: 'NY license' }, { identityChecked: false });
    expect(renamed.label).toBe('NY license');
    expect(renamed.hints.number).toBe('ends 8888');
  });

  test('inventory gives ids, labels, sites, fields, age, and expiry; never values or hints', async () => {
    withKey();
    fakeConvex();
    await createSecureItem('user_1', { kind: 'date_of_birth', values: { date: '1990-04-02' } });
    await createSecureItem('user_1', {
      kind: 'id_number',
      values: { type: 'passport', number: 'X1234567', country: 'US', expires: '2025-01-01' },
    });
    await createSecureItem('user_1', {
      kind: 'api_key',
      sites: ['api.openai.com'],
      values: { key: join('sk-', 'abcdefghijklmnop'), header: 'Authorization' },
    });
    const inventory = await secureInventory('user_1');
    expect(inventory).toEqual([
      {
        id: 'si_0000000000000000000000',
        kind: 'date_of_birth',
        label: 'Date of birth',
        sites: [],
        fields: ['date'],
        ageYears: 36,
      },
      {
        id: 'si_0000000000000000000001',
        kind: 'id_number',
        label: 'Passport',
        sites: [],
        fields: ['expires', 'number'],
        idType: 'passport',
        country: 'US',
        expired: true,
      },
      {
        id: 'si_0000000000000000000002',
        kind: 'api_key',
        label: 'API key',
        sites: ['api.openai.com'],
        fields: ['key'],
        header: 'Authorization',
      },
    ]);
    expect(JSON.stringify(inventory)).not.toContain('X1234567');
  });

  test('delete, uses, and recordUse pass through', async () => {
    withKey();
    const { calls } = fakeConvex();
    const id = (await createSecureItem('user_1', { kind: 'date_of_birth', values: { date: '1990-04-02' } }))
      .id;
    expect(await listSecureUses('user_1', id)).toEqual([
      {
        id: 'u1',
        itemId: id,
        field: 'number',
        site: 'ny.gov',
        workId: 'w1',
        workTitle: 'Renew the car registration',
        outcome: 'typed',
        at: 5,
      },
    ]);
    await recordSecureUse({ userId: 'user_1', itemId: id, outcome: 'typed', field: 'date', site: 'ny.gov' });
    expect(calls.find((call) => call.name === 'secureDetails:recordUse')?.args).toEqual({
      userId: 'user_1',
      itemId: id,
      outcome: 'typed',
      field: 'date',
      site: 'ny.gov',
    });
    expect(await deleteSecureItem('user_1', id)).toBe(true);
    expect(await deleteSecureItem('user_1', id)).toBe(false);
  });
});

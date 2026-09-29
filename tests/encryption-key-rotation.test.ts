import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import {
  DEFAULT_ENCRYPTION_KEY_ID,
  decryptSecret,
  encryptedKeyId,
  encryptionKeyring,
  encryptionWriteFormat,
  encryptSecret,
  needsReencryption,
  parseEncryptionKeyring,
  reencryptSecret,
} from '../lib/security/crypto';
import {
  ENCRYPTED_FIELDS,
  encryptedFieldKey,
  encryptedFieldsFor,
  encryptedTables,
  isEncryptedField,
  patchForEncryptedValue,
  readEncryptedValue,
} from '../lib/security/encrypted-fields';
import {
  assertRotationWriteFormat,
  formatRotationReport,
  type RotationStore,
  rotateEncryptedFields,
} from '../lib/security/key-rotation';

const ENV_KEYS = [
  'LAB86_MAIL_ENCRYPTION_KEY',
  'LAB86_MAIL_ENCRYPTION_KEY_ID',
  'LAB86_MAIL_ENCRYPTION_KEYS',
  'LAB86_MAIL_ENCRYPTION_WRITE_FORMAT',
] as const;
const saved: Record<string, string | undefined> = {};
const OLD_KEY = 'old-passphrase-for-rotation-tests';
const NEW_KEY = Buffer.alloc(32, 9).toString('base64');

beforeAll(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function setKeyringEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
}

// A value in the old v1 format, sealed the way the old code sealed it.
function legacyV1(plaintext: string, raw: string) {
  const key = createHash('sha256').update(raw).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

describe('encryption keyring', () => {
  test('with only the old variable, writes v2 under k1 and still reads old v1 values', () => {
    setKeyringEnv({ LAB86_MAIL_ENCRYPTION_KEY: OLD_KEY });
    const stored = legacyV1('old-token', OLD_KEY);
    const fresh = encryptSecret('new-token');

    expect(fresh.startsWith(`v2.${DEFAULT_ENCRYPTION_KEY_ID}.`)).toBe(true);
    expect(fresh.split('.')).toHaveLength(5);
    expect(decryptSecret(fresh)).toBe('new-token');
    expect(decryptSecret(stored)).toBe('old-token');
  });

  test('after a rotation, retired keys still open v1 and v2 values', () => {
    setKeyringEnv({ LAB86_MAIL_ENCRYPTION_KEY: OLD_KEY });
    const oldV1 = legacyV1('v1-token', OLD_KEY);
    const oldV2 = encryptSecret('v2-token');
    setKeyringEnv({
      LAB86_MAIL_ENCRYPTION_KEY: NEW_KEY,
      LAB86_MAIL_ENCRYPTION_KEY_ID: 'k2',
      LAB86_MAIL_ENCRYPTION_KEYS: `k1:${OLD_KEY}`,
    });

    expect(decryptSecret(oldV1)).toBe('v1-token');
    expect(decryptSecret(oldV2)).toBe('v2-token');
    expect(encryptSecret('x').startsWith('v2.k2.')).toBe(true);
    expect([...encryptionKeyring().keys.keys()]).toEqual(['k2', 'k1']);
  });

  test('a value under a key that is not in the ring does not open', () => {
    setKeyringEnv({ LAB86_MAIL_ENCRYPTION_KEY: OLD_KEY });
    const oldV1 = legacyV1('v1-token', OLD_KEY);
    const oldV2 = encryptSecret('v2-token');
    setKeyringEnv({ LAB86_MAIL_ENCRYPTION_KEY: NEW_KEY, LAB86_MAIL_ENCRYPTION_KEY_ID: 'k2' });

    expect(() => decryptSecret(oldV2)).toThrow('No encryption key with id "k1" is configured.');
    expect(() => decryptSecret(oldV1)).toThrow();
  });

  test('the key id is authenticated, so a changed id fails', () => {
    setKeyringEnv({
      LAB86_MAIL_ENCRYPTION_KEY: OLD_KEY,
      LAB86_MAIL_ENCRYPTION_KEYS: `k9:${OLD_KEY}`,
    });
    const value = encryptSecret('token');
    const relabeled = value.replace(/^v2\.k1\./, 'v2.k9.');

    expect(() => decryptSecret(relabeled)).toThrow();
  });

  test('rejects malformed payloads in both formats', () => {
    setKeyringEnv({ LAB86_MAIL_ENCRYPTION_KEY: OLD_KEY });
    for (const payload of ['not-a-payload', 'v2.k1.a.b', 'v1.a.b', 'v2.k1..b.c', '', 'v3.a.b.c']) {
      expect(() => decryptSecret(payload)).toThrow('Invalid encrypted secret payload.');
    }
  });

  test('the v1 write format keeps new writes readable by an older build', () => {
    setKeyringEnv({ LAB86_MAIL_ENCRYPTION_KEY: OLD_KEY, LAB86_MAIL_ENCRYPTION_WRITE_FORMAT: 'v1' });
    const value = encryptSecret('token');

    expect(value.startsWith('v1.')).toBe(true);
    expect(value.split('.')).toHaveLength(4);
    expect(decryptSecret(value)).toBe('token');
    expect(needsReencryption(value)).toBe(false);
    expect(needsReencryption(legacyV1('x', OLD_KEY))).toBe(false);
  });

  test('an unset write format writes v2, and a v1 value then needs re-encryption', () => {
    setKeyringEnv({ LAB86_MAIL_ENCRYPTION_KEY: OLD_KEY });
    expect(encryptionWriteFormat()).toBe('v2');
    const old = legacyV1('old-token', OLD_KEY);
    for (const value of [undefined, '', '  ', 'v2', ' V2 ']) {
      if (value === undefined) delete process.env.LAB86_MAIL_ENCRYPTION_WRITE_FORMAT;
      else process.env.LAB86_MAIL_ENCRYPTION_WRITE_FORMAT = value;
      const fresh = encryptSecret('token');
      expect(encryptedKeyId(fresh)).toBe(DEFAULT_ENCRYPTION_KEY_ID);
      expect(needsReencryption(fresh)).toBe(false);
      // A v1 value names no key, so it is never current under v2.
      expect(needsReencryption(old)).toBe(true);
      expect(encryptedKeyId(reencryptSecret(old).payload)).toBe(DEFAULT_ENCRYPTION_KEY_ID);
      expect(() => assertRotationWriteFormat()).not.toThrow();
    }
  });

  test('an explicit v1 write format keeps writes in v1 in any case, and stops the rotation', () => {
    setKeyringEnv({ LAB86_MAIL_ENCRYPTION_KEY: OLD_KEY });
    const current = encryptSecret('v2-token');
    for (const value of ['v1', 'V1', ' v1 ']) {
      process.env.LAB86_MAIL_ENCRYPTION_WRITE_FORMAT = value;
      expect(encryptionWriteFormat()).toBe('v1');
      const fresh = encryptSecret('token');
      expect(encryptedKeyId(fresh)).toBe('v1');
      expect(decryptSecret(fresh)).toBe('token');
      // An old build reads it: the old code opened v1 with no AAD.
      expect(fresh.split('.')).toHaveLength(4);
      expect(needsReencryption(fresh)).toBe(false);
      expect(needsReencryption(legacyV1('x', OLD_KEY))).toBe(false);
      // A v2 value goes back to v1 in the rollback window.
      expect(needsReencryption(current)).toBe(true);
      expect(() => assertRotationWriteFormat()).toThrow('Unset LAB86_MAIL_ENCRYPTION_WRITE_FORMAT');
    }
  });

  test('a write format that is not v1 or v2 stops each write and the rotation', () => {
    setKeyringEnv({ LAB86_MAIL_ENCRYPTION_KEY: OLD_KEY });
    const stored = encryptSecret('token');
    for (const value of ['v3', 'legacy', 'v1.', 'v 1']) {
      process.env.LAB86_MAIL_ENCRYPTION_WRITE_FORMAT = value;
      expect(() => encryptSecret('token')).toThrow('must be "v1", "v2", or unset');
      expect(() => assertRotationWriteFormat()).toThrow('must be "v1", "v2", or unset');
      expect(() => encryptionWriteFormat({ LAB86_MAIL_ENCRYPTION_WRITE_FORMAT: value })).toThrow();
      // Reads do not depend on the write format.
      expect(decryptSecret(stored)).toBe('token');
    }
  });

  test('parses the retired key list and refuses unclear configuration', () => {
    const keyring = parseEncryptionKeyring({
      key: NEW_KEY,
      keyId: ' k2 ',
      retiredKeys: ` k1:${OLD_KEY} , ,k0:a:b:c,k1:${OLD_KEY}`,
    });
    expect(keyring.currentKeyId).toBe('k2');
    expect([...keyring.keys.keys()]).toEqual(['k2', 'k1', 'k0']);
    // The key after the first colon is kept whole.
    expect(keyring.keys.get('k0')).toEqual(createHash('sha256').update('a:b:c').digest());
    expect(keyring.keys.get('k2')).toEqual(Buffer.alloc(32, 9));

    expect(() => parseEncryptionKeyring({})).toThrow(/LAB86_MAIL_ENCRYPTION_KEY is required/);
    expect(() => parseEncryptionKeyring({ key: 'x', keyId: 'bad.id' })).toThrow(/invalid key id/);
    expect(() => parseEncryptionKeyring({ key: 'x', keyId: 'v1' })).toThrow(/invalid key id/);
    expect(() => parseEncryptionKeyring({ key: 'x', retiredKeys: 'v2:y' })).toThrow(/invalid key id/);
    expect(() => parseEncryptionKeyring({ key: 'x', retiredKeys: 'nokey' })).toThrow(/"id:key" pairs/);
    expect(() => parseEncryptionKeyring({ key: 'x', retiredKeys: 'k2:' })).toThrow(/"id:key" pairs/);
    expect(() => parseEncryptionKeyring({ key: 'x', retiredKeys: ':y' })).toThrow(/"id:key" pairs/);
    expect(() => parseEncryptionKeyring({ key: 'x', retiredKeys: 'k1:y' })).toThrow(/second, different key/);
    expect(parseEncryptionKeyring({ key: 'x', retiredKeys: 'k1:x' }).keys.size).toBe(1);
  });

  test('reports key ids and re-encrypts only values that are not current', () => {
    setKeyringEnv({ LAB86_MAIL_ENCRYPTION_KEY: OLD_KEY });
    const oldV1 = legacyV1('token', OLD_KEY);
    const oldV2 = encryptSecret('token');
    setKeyringEnv({
      LAB86_MAIL_ENCRYPTION_KEY: NEW_KEY,
      LAB86_MAIL_ENCRYPTION_KEY_ID: 'k2',
      LAB86_MAIL_ENCRYPTION_KEYS: `k1:${OLD_KEY}`,
    });
    const current = encryptSecret('token');

    expect(encryptedKeyId(oldV1)).toBe('v1');
    expect(encryptedKeyId(oldV2)).toBe('k1');
    expect(encryptedKeyId(current)).toBe('k2');
    expect(encryptedKeyId('garbage')).toBeNull();
    expect(needsReencryption(oldV1)).toBe(true);
    expect(needsReencryption(oldV2)).toBe(true);
    expect(needsReencryption(current)).toBe(false);

    expect(reencryptSecret(current)).toEqual({ payload: current, changed: false });
    for (const value of [oldV1, oldV2]) {
      const next = reencryptSecret(value);
      expect(next.changed).toBe(true);
      expect(encryptedKeyId(next.payload)).toBe('k2');
      expect(decryptSecret(next.payload)).toBe('token');
    }
    expect(() => reencryptSecret('garbage')).toThrow('Invalid encrypted secret payload.');
  });
});

describe('encrypted field registry', () => {
  test('lists every schema field whose name says it is encrypted', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'convex', 'schema.ts'), 'utf8');
    const tableStarts = [...source.matchAll(/\n {2}(\w+): defineTable\(/g)].map((match) => ({
      table: match[1],
      at: match.index ?? 0,
    }));
    const found = [...source.matchAll(/\b(\w*Encrypted\w*|encrypted\w*):/g)].map((match) => {
      const at = match.index ?? 0;
      const table = tableStarts.filter((start) => start.at < at).at(-1)?.table ?? '?';
      return `${table}.${match[1]}`;
    });
    const registered = new Set(ENCRYPTED_FIELDS.map((field) => `${field.table}.${field.path.at(-1)}`));

    expect(found.length).toBeGreaterThan(10);
    expect(found.filter((key) => !registered.has(key))).toEqual([]);
  });

  test('lists only tables that exist in the schema', () => {
    const tables = Object.keys((schema as any).tables);
    expect(encryptedTables().filter((table) => !tables.includes(table))).toEqual([]);
  });

  test('reads and patches nested values without touching their siblings', () => {
    const document = {
      google: { connectionId: 'c', session: 's1', pendingSave: { session: 's2', revision: 3 } },
    };

    expect(readEncryptedValue(document, ['google', 'session'])).toBe('s1');
    expect(readEncryptedValue(document, ['google', 'pendingSave', 'session'])).toBe('s2');
    expect(readEncryptedValue(document, ['google', 'missing', 'session'])).toBeUndefined();
    expect(readEncryptedValue({ google: { session: 5 } }, ['google', 'session'])).toBeUndefined();
    expect(patchForEncryptedValue(document, ['google', 'pendingSave', 'session'], 'n')).toEqual({
      google: { connectionId: 'c', session: 's1', pendingSave: { session: 'n', revision: 3 } },
    });
    expect(patchForEncryptedValue({}, ['accessTokenEncrypted'], 'n')).toEqual({ accessTokenEncrypted: 'n' });
    expect(isEncryptedField('officeDocuments', ['google', 'session'])).toBe(true);
    expect(isEncryptedField('officeDocuments', ['title'])).toBe(false);
    expect(encryptedFieldsFor('users')).toEqual([]);
    expect(encryptedFieldKey({ table: 't', path: ['a', 'b'] })).toBe('t.a.b');
  });
});

function memoryStore(rows: Record<string, Array<{ id: string; doc: Record<string, unknown> }>>) {
  const writes: Array<{ table: string; id: string; path: string[] }> = [];
  const store: RotationStore = {
    async listPage({ table, cursor, numItems }) {
      const all = rows[table] ?? [];
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + numItems);
      return {
        rows: slice.map((row) => ({
          id: row.id,
          values: encryptedFieldsFor(table).flatMap((field) => {
            const value = readEncryptedValue(row.doc, field.path);
            return value === undefined ? [] : [{ path: [...field.path], value }];
          }),
        })),
        continueCursor: String(start + numItems),
        isDone: start + numItems >= all.length,
      };
    },
    async replace({ table, id, path, expected, next }) {
      const row = (rows[table] ?? []).find((candidate) => candidate.id === id);
      if (!row || readEncryptedValue(row.doc, path) !== expected) return { replaced: false };
      Object.assign(row.doc, patchForEncryptedValue(row.doc, path, next));
      writes.push({ table, id, path });
      return { replaced: true };
    },
  };
  return { store, writes };
}

describe('key rotation', () => {
  function rotatedWorld() {
    setKeyringEnv({ LAB86_MAIL_ENCRYPTION_KEY: OLD_KEY });
    const oldV1 = legacyV1('refresh', OLD_KEY);
    const oldV2 = encryptSecret('access');
    const lost = legacyV1('lost', 'a-key-nobody-has');
    setKeyringEnv({
      LAB86_MAIL_ENCRYPTION_KEY: NEW_KEY,
      LAB86_MAIL_ENCRYPTION_KEY_ID: 'k2',
      LAB86_MAIL_ENCRYPTION_KEYS: `k1:${OLD_KEY}`,
    });
    const current = encryptSecret('current');
    return {
      rows: {
        providerGrants: [
          { id: 'g1', doc: { accessTokenEncrypted: oldV2, refreshTokenEncrypted: oldV1 } },
          { id: 'g2', doc: { accessTokenEncrypted: current } },
          { id: 'g3', doc: { accessTokenEncrypted: lost } },
        ],
        officeDocuments: [{ id: 'o1', doc: { google: { session: oldV2, pendingSave: { session: oldV1 } } } }],
      },
    };
  }

  test('a dry run counts values by key id and writes nothing', async () => {
    const { rows } = rotatedWorld();
    const { store, writes } = memoryStore(rows);

    const report = await rotateEncryptedFields(store, { apply: false, pageSize: 2 });

    expect(writes).toEqual([]);
    expect(report.currentKeyId).toBe('k2');
    expect(report.fields['providerGrants.accessTokenEncrypted']).toEqual({
      total: 3,
      current: 1,
      byKeyId: { k1: 1, k2: 1, v1: 1 },
      undecryptable: 1,
      reencrypted: 0,
      skipped: 0,
    });
    expect(report.fields['officeDocuments.google.pendingSave.session'].total).toBe(1);
    expect(report.fields['aiProviderKeys.encryptedKey'].total).toBe(0);
    const text = formatRotationReport(report).join('\n');
    expect(text).toContain('DRY RUN: current key id "k2"');
    expect(text).toContain('providerGrants.accessTokenEncrypted | 3 | 1 | k1=1 k2=1 v1=1 | 1 | 0 | 0');
    expect(text).toContain('aiProviderKeys.encryptedKey | 0 | 0 | - | 0 | 0 | 0');
    expect(text).not.toContain(rows.providerGrants[0].doc.accessTokenEncrypted as string);
  });

  test('the v1 write format stops a dry run too, before any read', async () => {
    const { rows } = rotatedWorld();
    const { store, writes } = memoryStore(rows);
    let reads = 0;
    const counting: RotationStore = {
      ...store,
      listPage: (input) => {
        reads += 1;
        return store.listPage(input);
      },
    };
    process.env.LAB86_MAIL_ENCRYPTION_WRITE_FORMAT = 'v1';
    for (const apply of [false, true]) {
      await expect(rotateEncryptedFields(counting, { apply })).rejects.toThrow(
        'Unset LAB86_MAIL_ENCRYPTION_WRITE_FORMAT',
      );
    }
    expect(reads).toBe(0);
    expect(writes).toEqual([]);
    expect(() => assertRotationWriteFormat({ LAB86_MAIL_ENCRYPTION_WRITE_FORMAT: 'v2' })).not.toThrow();
    expect(() => assertRotationWriteFormat({})).not.toThrow();
  });

  test('apply re-encrypts old values, keeps current ones, and skips values it cannot open', async () => {
    const { rows } = rotatedWorld();
    const { store, writes } = memoryStore(rows);

    const report = await rotateEncryptedFields(store, {
      apply: true,
      tables: ['providerGrants', 'officeDocuments'],
    });

    expect(writes.map((write) => `${write.id}:${write.path.join('.')}`)).toEqual([
      'g1:accessTokenEncrypted',
      'g1:refreshTokenEncrypted',
      'o1:google.session',
      'o1:google.pendingSave.session',
    ]);
    expect(report.fields['providerGrants.accessTokenEncrypted']).toMatchObject({
      reencrypted: 1,
      undecryptable: 1,
    });
    expect(Object.keys(report.fields).every((key) => /^(providerGrants|officeDocuments)\./.test(key))).toBe(
      true,
    );
    const g1 = rows.providerGrants[0].doc;
    expect(decryptSecret(g1.accessTokenEncrypted as string)).toBe('access');
    expect(decryptSecret(g1.refreshTokenEncrypted as string)).toBe('refresh');
    expect(encryptedKeyId(g1.refreshTokenEncrypted as string)).toBe('k2');
    const session = (rows.officeDocuments[0].doc.google as any).pendingSave.session;
    expect(encryptedKeyId(session)).toBe('k2');
    expect(formatRotationReport(report)[0]).toBe('APPLY: current key id "k2"');
  });

  test('a value that changed after the read is skipped, not overwritten', async () => {
    const { rows } = rotatedWorld();
    const { store } = memoryStore(rows);
    const racing: RotationStore = {
      listPage: store.listPage,
      replace: async () => ({ replaced: false }),
    };

    const report = await rotateEncryptedFields(racing, { apply: true, tables: ['providerGrants'] });

    expect(report.fields['providerGrants.accessTokenEncrypted'].skipped).toBe(1);
    expect(report.fields['providerGrants.refreshTokenEncrypted'].skipped).toBe(1);
  });

  test('refuses a table with no registered encrypted fields and ignores unknown paths', async () => {
    const { store } = memoryStore({});
    await expect(rotateEncryptedFields(store, { apply: false, tables: ['users'] })).rejects.toThrow(
      'Table users holds no registered encrypted fields.',
    );

    setKeyringEnv({ LAB86_MAIL_ENCRYPTION_KEY: OLD_KEY });
    const odd: RotationStore = {
      listPage: async () => ({
        rows: [{ id: 'x', values: [{ path: ['notRegistered'], value: 'v2.k1.a.b.c' }] }],
        continueCursor: '',
        isDone: true,
      }),
      replace: async () => ({ replaced: true }),
    };
    const report = await rotateEncryptedFields(odd, { apply: true, tables: ['aiProviderKeys'] });
    expect(report.fields['aiProviderKeys.encryptedKey'].total).toBe(0);
  });
});

const SECRET = 'encryption-rotation-secret';
let previousSecret: string | undefined;

describe('encryption rotation (Convex)', () => {
  const modules = {
    '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
    '../convex/encryptionRotation.ts': () => import('../convex/encryptionRotation'),
  };

  beforeAll(() => {
    previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
  });

  afterAll(() => {
    if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
  });

  const NEXT = 'v2.k2.aXY.dGFn.Y2lwaGVy';

  async function seed() {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const grant = await ctx.db.insert('providerGrants', {
        userId: 'u',
        accountId: 'a',
        provider: 'google',
        grantId: 'g',
        email: 'a@example.test',
        accessTokenEncrypted: 'v1.old.access.x',
        scopes: [],
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('providerGrants', {
        userId: 'u',
        accountId: 'b',
        provider: 'google',
        grantId: 'h',
        email: 'b@example.test',
        scopes: [],
        createdAt: 1,
        updatedAt: 1,
      });
      const office = await ctx.db.insert('officeDocuments', {
        userId: 'u',
        documentId: 'd',
        title: 'Doc',
        extension: 'docx',
        currentRevision: 1,
        createdAt: 1,
        updatedAt: 1,
        google: {
          connectionId: 'c',
          fileId: 'f',
          session: 'v1.s.e.ssion',
          syncedRevision: 1,
          pendingSave: { session: 'v1.p.e.nding', revision: 2, providerVersion: '7' },
        },
      });
      return { grant, office };
    });
    return { t, ...ids };
  }

  test('lists encrypted values page by page and leaves out absent fields', async () => {
    const { t, grant } = await seed();
    const first = await t.query(api.encryptionRotation.listEncryptedPage, {
      internalSecret: SECRET,
      table: 'providerGrants',
      cursor: null,
      numItems: 1,
    });
    expect(first.rows).toEqual([
      { id: String(grant), values: [{ path: ['accessTokenEncrypted'], value: 'v1.old.access.x' }] },
    ]);
    expect(first.isDone).toBe(false);
    const second = await t.query(api.encryptionRotation.listEncryptedPage, {
      internalSecret: SECRET,
      table: 'providerGrants',
      cursor: first.continueCursor,
      numItems: 0,
    });
    expect(second.rows[0].values).toEqual([]);

    const office = await t.query(api.encryptionRotation.listEncryptedPage, {
      internalSecret: SECRET,
      table: 'officeDocuments',
      cursor: null,
      numItems: 500,
    });
    expect(office.rows[0].values.map((value) => value.path.join('.'))).toEqual([
      'google.session',
      'google.pendingSave.session',
    ]);
  });

  test('replaces a value only when it still holds the value that was read', async () => {
    const { t, grant, office } = await seed();
    const stale = await t.mutation(api.encryptionRotation.replaceEncryptedValue, {
      internalSecret: SECRET,
      table: 'providerGrants',
      id: String(grant),
      path: ['accessTokenEncrypted'],
      expected: 'v1.something.else.x',
      next: NEXT,
    });
    const fresh = await t.mutation(api.encryptionRotation.replaceEncryptedValue, {
      internalSecret: SECRET,
      table: 'providerGrants',
      id: String(grant),
      path: ['accessTokenEncrypted'],
      expected: 'v1.old.access.x',
      next: NEXT,
    });
    const nested = await t.mutation(api.encryptionRotation.replaceEncryptedValue, {
      internalSecret: SECRET,
      table: 'officeDocuments',
      id: String(office),
      path: ['google', 'pendingSave', 'session'],
      expected: 'v1.p.e.nding',
      next: NEXT,
    });
    const missing = await t.mutation(api.encryptionRotation.replaceEncryptedValue, {
      internalSecret: SECRET,
      table: 'providerGrants',
      id: 'not-an-id',
      path: ['accessTokenEncrypted'],
      expected: 'x',
      next: NEXT,
    });

    expect([stale, fresh, nested, missing]).toEqual([
      { replaced: false },
      { replaced: true },
      { replaced: true },
      { replaced: false },
    ]);
    const rows = await t.run(async (ctx) => ({
      grant: await ctx.db.get(grant),
      office: await ctx.db.get(office),
    }));
    expect(rows.grant?.accessTokenEncrypted).toBe(NEXT);
    expect(rows.office?.google).toEqual({
      connectionId: 'c',
      fileId: 'f',
      session: 'v1.s.e.ssion',
      syncedRevision: 1,
      pendingSave: { session: NEXT, revision: 2, providerVersion: '7' },
    });
  });

  test('refuses other fields, non-v2 values, unknown tables, and callers without the secret', async () => {
    const { t, grant } = await seed();
    const base = {
      internalSecret: SECRET,
      table: 'providerGrants',
      id: String(grant),
      path: ['accessTokenEncrypted'],
      expected: 'v1.old.access.x',
      next: NEXT,
    };

    await expect(
      t.mutation(api.encryptionRotation.replaceEncryptedValue, { ...base, path: ['email'] }),
    ).rejects.toThrow(/not a registered encrypted field/);
    await expect(
      t.mutation(api.encryptionRotation.replaceEncryptedValue, { ...base, next: 'plaintext-token' }),
    ).rejects.toThrow(/not a v2 encrypted value/);
    await expect(
      t.mutation(api.encryptionRotation.replaceEncryptedValue, { ...base, internalSecret: 'wrong' }),
    ).rejects.toThrow();
    await expect(
      t.query(api.encryptionRotation.listEncryptedPage, {
        internalSecret: SECRET,
        table: 'users',
        cursor: null,
        numItems: 10,
      }),
    ).rejects.toThrow(/no registered encrypted fields/);
  });
});

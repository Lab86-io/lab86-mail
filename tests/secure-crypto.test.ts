import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  isSealed,
  newSecureItemId,
  openSecureValues,
  parseSecureKeyring,
  rewrapDataKey,
  SecureKeyError,
  sealSecureValues,
  secureAad,
} from '../lib/secure/crypto';
import { formatSecureRotationReport, rotateSecureKek } from '../lib/secure/rotation';

// Envelope encryption for Passwords and IDs (docs/albatross-secure-store.md).

const key = () => randomBytes(32).toString('base64');
const ring = (id = 's1', value = key(), retired?: string) =>
  parseSecureKeyring({ key: value, keyId: id, retiredKeys: retired }) as NonNullable<
    ReturnType<typeof parseSecureKeyring>
  >;
const binding = { userId: 'user_1', itemId: 'si_aaaaaaaaaaaaaaaaaaaaaa', kind: 'sign_in' };
const fakePassword = ['correct', '-horse-', 'battery'].join('');

describe('secure keyring', () => {
  test('no key means the store is off', () => {
    expect(parseSecureKeyring({})).toBeNull();
    expect(parseSecureKeyring({ key: '  ' })).toBeNull();
  });

  test('the key must be 32 random bytes; a phrase is refused', () => {
    expect(() => parseSecureKeyring({ key: 'a long pass phrase that is not base64!' })).toThrow(
      SecureKeyError,
    );
    expect(() => parseSecureKeyring({ key: randomBytes(16).toString('base64') })).toThrow(/32 random bytes/);
    expect(ring().currentKeyId).toBe('s1');
    expect(parseSecureKeyring({ key: key() })?.currentKeyId).toBe('s1');
  });

  test('retired keys load; bad ids and conflicting keys are refused', () => {
    const old = key();
    const keyring = ring('s2', key(), `s1:${old}`);
    expect([...keyring.keys.keys()]).toEqual(['s2', 's1']);
    expect(() => ring('sv1')).toThrow(/invalid key id/);
    expect(() => ring('s2', key(), 'nokey')).toThrow(/id:key/);
    expect(() => ring('s2', old, `s2:${key()}`)).toThrow(/second, different key/);
  });
});

describe('sealing', () => {
  test('a sealed item opens only with the same user, item, and kind', () => {
    const keyring = ring();
    const sealed = sealSecureValues(
      binding,
      { username: 'sam.rivera@example.com', password: fakePassword },
      keyring,
    );
    expect(isSealed(sealed.payloadSealed)).toBe(true);
    expect(isSealed(sealed.dataKeyWrapped)).toBe(true);
    expect(sealed.payloadSealed).not.toContain('horse');
    expect(openSecureValues(binding, sealed, keyring)).toEqual({
      username: 'sam.rivera@example.com',
      password: fakePassword,
    });
    for (const other of [
      { ...binding, userId: 'user_2' },
      { ...binding, itemId: 'si_bbbbbbbbbbbbbbbbbbbbbb' },
      { ...binding, kind: 'api_key' },
    ])
      expect(() => openSecureValues(other, sealed, keyring)).toThrow();
  });

  test('each seal uses a new data key, so two seals of one value differ', () => {
    const keyring = ring();
    const a = sealSecureValues(binding, { password: fakePassword }, keyring);
    const b = sealSecureValues(binding, { password: fakePassword }, keyring);
    expect(a.payloadSealed).not.toBe(b.payloadSealed);
    expect(a.dataKeyWrapped).not.toBe(b.dataKeyWrapped);
  });

  test('a wrong key, an unknown key id, a changed byte, or no keyring fails', () => {
    const sealed = sealSecureValues(binding, { password: fakePassword }, ring());
    expect(() => openSecureValues(binding, sealed, ring())).toThrow();
    expect(() => openSecureValues(binding, { ...sealed, kekId: 's9' }, ring())).toThrow(/No secure key/);
    expect(() => openSecureValues(binding, { ...sealed, payloadSealed: 'v2.x.y.z' }, ring())).toThrow();
    expect(() => sealSecureValues(binding, { password: 'x' }, null)).toThrow(/not set up/);
  });

  test('the payload key cannot open as the data key (separate AAD suffixes)', () => {
    expect(secureAad(binding)).toBe('secure:v1:user_1:si_aaaaaaaaaaaaaaaaaaaaaa:sign_in');
    const keyring = ring();
    const sealed = sealSecureValues(binding, { password: fakePassword }, keyring);
    expect(() =>
      openSecureValues(binding, { ...sealed, payloadSealed: sealed.dataKeyWrapped }, keyring),
    ).toThrow();
  });

  test('item ids are random and in the stored format', () => {
    const id = newSecureItemId();
    expect(id).toMatch(/^si_[A-Za-z0-9_-]{22}$/);
    expect(newSecureItemId()).not.toBe(id);
  });
});

describe('key rotation', () => {
  test('rewrap moves the data key to the current KEK; the payload still opens', () => {
    const oldKey = key();
    const before = ring('s1', oldKey);
    const sealed = sealSecureValues(binding, { password: fakePassword }, before);
    const after = ring('s2', key(), `s1:${oldKey}`);
    const next = rewrapDataKey(binding, sealed, after);
    expect(next).toMatchObject({ kekId: 's2', changed: true });
    expect(
      openSecureValues(
        binding,
        { ...sealed, ...next },
        ring('s2', [...after.keys.values()][0].toString('base64')),
      ),
    ).toEqual({ password: fakePassword });
    expect(rewrapDataKey(binding, { ...sealed, ...next }, after).changed).toBe(false);
    expect(() => rewrapDataKey(binding, sealed, ring('s3'))).toThrow(/No secure key/);
  });

  test('the rotation run reports counts, re-wraps only in apply mode, and skips changed rows', async () => {
    const oldKey = key();
    const before = ring('s1', oldKey);
    const rows = [0, 1, 2].map((index) => {
      const itemId = `si_${String(index).repeat(22)}`;
      const sealed = sealSecureValues({ ...binding, itemId }, { password: fakePassword }, before);
      return { id: `r${index}`, userId: binding.userId, itemId, kind: 'sign_in', ...sealed };
    });
    rows.push({ ...rows[0], id: 'lost', kekId: 's0' });
    const after = ring('s2', key(), `s1:${oldKey}`);
    const writes: string[] = [];
    const store = {
      listPage: async ({ cursor }: { cursor: string | null }) =>
        cursor
          ? { rows: rows.slice(2), continueCursor: 'end', isDone: true }
          : { rows: rows.slice(0, 2), continueCursor: 'p2', isDone: false },
      rewrap: async (input: { id: string }) => {
        writes.push(input.id);
        return { replaced: input.id !== 'r2' };
      },
    };
    const dry = await rotateSecureKek(store, { apply: false, pageSize: 2 }, after);
    expect(dry).toMatchObject({ total: 4, current: 0, unopened: 1, rewrapped: 0, byKeyId: { s1: 3, s0: 1 } });
    expect(writes).toEqual([]);
    const applied = await rotateSecureKek(store, { apply: true }, after);
    expect(applied).toMatchObject({ rewrapped: 2, skipped: 1, unopened: 1 });
    expect(formatSecureRotationReport(applied).join('\n')).toContain('Re-wrapped: 2');
    await expect(rotateSecureKek(store, { apply: false }, null)).rejects.toThrow(/not set/);
  });
});

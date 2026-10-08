import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Envelope encryption for secure details (docs/albatross-secure-store.md).
//
// Each item has its own random 256-bit data key. The data key seals the
// item's values (AES-256-GCM), and the key-encryption key (KEK) wraps the data
// key (AES-256-GCM). Both layers bind the AAD
// `secure:v1:<userId>:<itemId>:<kind>`, so a sealed value never opens for
// another user, another item, or another kind.
//
// The KEK is separate from the mail encryption key:
//   LAB86_SECURE_KEK       32 random bytes, base64 (no derivation from a phrase)
//   LAB86_SECURE_KEK_ID    the id of that key; default "s1"
//   LAB86_SECURE_KEKS      optional retired keys that only unwrap, "id:key,id:key"
// Without LAB86_SECURE_KEK the store is off. The key must be backed up: no
// item opens without it. scripts/rotate-secure-kek.ts re-wraps the data keys.
//
// Sealed format: "sv1.<iv>.<tag>.<ciphertext>" (base64url parts).

const FORMAT = 'sv1';
export const DEFAULT_SECURE_KEK_ID = 's1';
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

export interface SecureKeyring {
  currentKeyId: string;
  keys: Map<string, Buffer>;
}

export class SecureKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecureKeyError';
  }
}

function decodeKey(raw: string, source: string): Buffer {
  const trimmed = raw.trim();
  const decoded = /^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed) ? Buffer.from(trimmed, 'base64') : null;
  if (!decoded || decoded.length !== 32)
    throw new SecureKeyError(`${source} must be 32 random bytes in base64.`);
  return decoded;
}

function checkedKeyId(id: string, source: string) {
  if (!KEY_ID.test(id) || id === FORMAT) throw new SecureKeyError(`${source} has an invalid key id.`);
  return id;
}

/** The keyring from the given values, or null when no current key is set. */
export function parseSecureKeyring(env: {
  key?: string;
  keyId?: string;
  retiredKeys?: string;
}): SecureKeyring | null {
  if (!env.key?.trim()) return null;
  const currentKeyId = checkedKeyId((env.keyId || '').trim() || DEFAULT_SECURE_KEK_ID, 'LAB86_SECURE_KEK_ID');
  const keys = new Map<string, Buffer>([[currentKeyId, decodeKey(env.key, 'LAB86_SECURE_KEK')]]);
  for (const entry of (env.retiredKeys || '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) throw new SecureKeyError('LAB86_SECURE_KEKS must hold "id:key" pairs.');
    const id = checkedKeyId(trimmed.slice(0, separator).trim(), 'LAB86_SECURE_KEKS');
    const key = decodeKey(trimmed.slice(separator + 1), 'LAB86_SECURE_KEKS');
    const known = keys.get(id);
    if (known && !known.equals(key))
      throw new SecureKeyError(`LAB86_SECURE_KEKS gives key id "${id}" a second, different key.`);
    keys.set(id, key);
  }
  return { currentKeyId, keys };
}

let cached: { signature: string; keyring: SecureKeyring | null } | null = null;

/** The keyring from the environment, or null when the store has no key. */
export function secureKeyring(): SecureKeyring | null {
  const env = {
    key: process.env.LAB86_SECURE_KEK,
    keyId: process.env.LAB86_SECURE_KEK_ID,
    retiredKeys: process.env.LAB86_SECURE_KEKS,
  };
  const signature = JSON.stringify(env);
  if (cached?.signature !== signature) cached = { signature, keyring: parseSecureKeyring(env) };
  return cached.keyring;
}

function requireKeyring(keyring: SecureKeyring | null | undefined): SecureKeyring {
  if (!keyring) throw new SecureKeyError('Passwords and IDs is not set up on this server.');
  return keyring;
}

export interface SecureBinding {
  userId: string;
  itemId: string;
  kind: string;
}

/** The AAD of one item. Both layers add a suffix, so a payload never opens as a key. */
export function secureAad(binding: SecureBinding) {
  return `secure:v1:${binding.userId}:${binding.itemId}:${binding.kind}`;
}

function seal(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    FORMAT,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

function open(key: Buffer, sealed: string, aad: string): Buffer {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 4 || parts[0] !== FORMAT || !parts.every(Boolean))
    throw new SecureKeyError('The sealed value has an unknown format.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]);
}

/** True for a value in the sealed format. Convex checks this before a write. */
export function isSealed(value: string) {
  return /^sv1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

export interface SealedItem {
  payloadSealed: string;
  dataKeyWrapped: string;
  kekId: string;
}

/** Seal the values of one item under a new data key. */
export function sealSecureValues(
  binding: SecureBinding,
  values: Record<string, string>,
  keyring: SecureKeyring | null = secureKeyring(),
): SealedItem {
  const ring = requireKeyring(keyring);
  const kek = ring.keys.get(ring.currentKeyId) as Buffer;
  const aad = secureAad(binding);
  const dataKey = randomBytes(32);
  const plaintext = Buffer.from(JSON.stringify(values), 'utf8');
  try {
    return {
      payloadSealed: seal(dataKey, plaintext, `${aad}:payload`),
      dataKeyWrapped: seal(kek, dataKey, `${aad}:key:${ring.currentKeyId}`),
      kekId: ring.currentKeyId,
    };
  } finally {
    dataKey.fill(0);
    plaintext.fill(0);
  }
}

/** Open the values of one item. Throws when the key, the binding, or the data is wrong. */
export function openSecureValues(
  binding: SecureBinding,
  sealed: SealedItem,
  keyring: SecureKeyring | null = secureKeyring(),
): Record<string, string> {
  const ring = requireKeyring(keyring);
  const kek = ring.keys.get(sealed.kekId);
  if (!kek) throw new SecureKeyError(`No secure key with id "${sealed.kekId}" is configured.`);
  const aad = secureAad(binding);
  const dataKey = open(kek, sealed.dataKeyWrapped, `${aad}:key:${sealed.kekId}`);
  try {
    const plaintext = open(dataKey, sealed.payloadSealed, `${aad}:payload`);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(plaintext.toString('utf8'));
      } catch {
        // A JSON error message can quote its input; this one never holds a value.
        throw new SecureKeyError('The sealed value is not valid.');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new SecureKeyError('The sealed value is not an object.');
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
    } finally {
      plaintext.fill(0);
    }
  } finally {
    dataKey.fill(0);
  }
}

/**
 * The data key wrapped under the current KEK. The payload does not change.
 * A key that is already current comes back unchanged.
 */
export function rewrapDataKey(
  binding: SecureBinding,
  sealed: SealedItem,
  keyring: SecureKeyring | null = secureKeyring(),
): { dataKeyWrapped: string; kekId: string; changed: boolean } {
  const ring = requireKeyring(keyring);
  if (sealed.kekId === ring.currentKeyId)
    return { dataKeyWrapped: sealed.dataKeyWrapped, kekId: sealed.kekId, changed: false };
  const oldKek = ring.keys.get(sealed.kekId);
  if (!oldKek) throw new SecureKeyError(`No secure key with id "${sealed.kekId}" is configured.`);
  const aad = secureAad(binding);
  const dataKey = open(oldKek, sealed.dataKeyWrapped, `${aad}:key:${sealed.kekId}`);
  try {
    return {
      dataKeyWrapped: seal(
        ring.keys.get(ring.currentKeyId) as Buffer,
        dataKey,
        `${aad}:key:${ring.currentKeyId}`,
      ),
      kekId: ring.currentKeyId,
      changed: true,
    };
  } finally {
    dataKey.fill(0);
  }
}

/** A new public item id: 16 random bytes, base64url, with a prefix. */
export function newSecureItemId() {
  return `si_${randomBytes(16).toString('base64url')}`;
}

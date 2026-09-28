import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Encrypted secrets at rest (provider tokens, file and tool credentials, user
// model keys, OAuth transaction rows). AES-256-GCM with a random 96-bit IV.
//
// Formats:
//   v1.<iv>.<tag>.<ciphertext>          old writes, no key id
//   v2.<kid>.<iv>.<tag>.<ciphertext>    new writes; "v2.<kid>" is the AAD
//
// Keyring (all from the environment):
//   LAB86_MAIL_ENCRYPTION_KEY     the key for new writes (unchanged meaning)
//   LAB86_MAIL_ENCRYPTION_KEY_ID  the id of that key; default "k1"
//   LAB86_MAIL_ENCRYPTION_KEYS    optional retired keys that only decrypt,
//                                 as "id:key,id:key"
//   LAB86_MAIL_ENCRYPTION_WRITE_FORMAT
//                                 optional; "v1" keeps new writes in the old
//                                 format (current key), so a rollback to a
//                                 build that reads v1 only stays safe
// With only LAB86_MAIL_ENCRYPTION_KEY set, the keyring is { k1 } and every
// stored v1 value still decrypts. See docs/encryption-key-rotation.md.

const V1 = 'v1';
const V2 = 'v2';
export const DEFAULT_ENCRYPTION_KEY_ID = 'k1';
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export interface EncryptionKeyring {
  currentKeyId: string;
  // Insertion order: the current key first, then retired keys as listed.
  keys: Map<string, Buffer>;
}

function deriveKey(raw: string) {
  if (/^[A-Za-z0-9+/=]{43,}$/.test(raw)) {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  }
  return createHash('sha256').update(raw).digest();
}

function checkedKeyId(id: string, source: string) {
  // "v1" and "v2" name formats, so they cannot also name a key.
  if (!KEY_ID_PATTERN.test(id) || id === V1 || id === V2) {
    throw new Error(`${source} has an invalid key id. Use 1-32 letters, digits, "_" or "-".`);
  }
  return id;
}

export function parseEncryptionKeyring(env: {
  key?: string;
  keyId?: string;
  retiredKeys?: string;
}): EncryptionKeyring {
  const raw = env.key || '';
  if (!raw) {
    throw new Error('LAB86_MAIL_ENCRYPTION_KEY is required for encrypted hosted secrets.');
  }
  const currentKeyId = checkedKeyId(
    (env.keyId || '').trim() || DEFAULT_ENCRYPTION_KEY_ID,
    'LAB86_MAIL_ENCRYPTION_KEY_ID',
  );
  const current = deriveKey(raw);
  const keys = new Map<string, Buffer>([[currentKeyId, current]]);
  for (const entry of (env.retiredKeys || '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    if (separator <= 0 || separator === trimmed.length - 1) {
      throw new Error('LAB86_MAIL_ENCRYPTION_KEYS must hold "id:key" pairs, separated by commas.');
    }
    const id = checkedKeyId(trimmed.slice(0, separator).trim(), 'LAB86_MAIL_ENCRYPTION_KEYS');
    const key = deriveKey(trimmed.slice(separator + 1).trim());
    const known = keys.get(id);
    if (known && !known.equals(key)) {
      throw new Error(`LAB86_MAIL_ENCRYPTION_KEYS gives key id "${id}" a second, different key.`);
    }
    keys.set(id, key);
  }
  return { currentKeyId, keys };
}

let cached: { signature: string; keyring: EncryptionKeyring } | null = null;

/** The keyring from the environment. It is parsed again when the env changes. */
export function encryptionKeyring(): EncryptionKeyring {
  const env = {
    key: process.env.LAB86_MAIL_ENCRYPTION_KEY,
    keyId: process.env.LAB86_MAIL_ENCRYPTION_KEY_ID,
    retiredKeys: process.env.LAB86_MAIL_ENCRYPTION_KEYS,
  };
  const signature = JSON.stringify(env);
  if (cached?.signature !== signature) cached = { signature, keyring: parseEncryptionKeyring(env) };
  return cached.keyring;
}

function writesV1() {
  return process.env.LAB86_MAIL_ENCRYPTION_WRITE_FORMAT === V1;
}

export function encryptSecret(plaintext: string) {
  const keyring = encryptionKeyring();
  const kid = keyring.currentKeyId;
  const legacy = writesV1();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyring.keys.get(kid) as Buffer, iv);
  if (!legacy) cipher.setAAD(Buffer.from(`${V2}.${kid}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const sealed = [
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ];
  return legacy ? [V1, ...sealed].join('.') : [V2, kid, ...sealed].join('.');
}

function open(key: Buffer, ivRaw: string, tagRaw: string, ciphertextRaw: string, aad?: string) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'), {
    authTagLength: 16,
  });
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}

export function decryptSecret(payload: string) {
  const parts = String(payload || '').split('.');
  const keyring = encryptionKeyring();
  if (parts[0] === V2 && parts.length === 5 && parts.every(Boolean)) {
    const [, kid, ivRaw, tagRaw, ciphertextRaw] = parts;
    const key = keyring.keys.get(kid);
    if (!key) throw new Error(`No encryption key with id "${kid}" is configured.`);
    return open(key, ivRaw, tagRaw, ciphertextRaw, `${V2}.${kid}`);
  }
  if (parts[0] === V1 && parts.length === 4 && parts.every(Boolean)) {
    // A v1 value names no key. The GCM tag rejects a wrong key, so each key
    // in the ring is tried: the current key first, then the retired keys.
    const [, ivRaw, tagRaw, ciphertextRaw] = parts;
    let lastError: unknown;
    for (const key of keyring.keys.values()) {
      try {
        return open(key, ivRaw, tagRaw, ciphertextRaw);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
  throw new Error('Invalid encrypted secret payload.');
}

/** The key id of a stored value: the id for v2, "v1" for a value with no id, else null. */
export function encryptedKeyId(payload: string): string | null {
  const parts = String(payload || '').split('.');
  if (parts[0] === V2 && parts.length === 5 && parts.every(Boolean)) return parts[1];
  if (parts[0] === V1 && parts.length === 4 && parts.every(Boolean)) return V1;
  return null;
}

/**
 * True when the value is not in the write format under the current key. With
 * the v1 write format, every v1 value counts as current (it has no key id).
 */
export function needsReencryption(payload: string) {
  const kid = encryptedKeyId(payload);
  return kid !== (writesV1() ? V1 : encryptionKeyring().currentKeyId);
}

/**
 * The value under the current key. A value that is already current comes
 * back unchanged. A value that no configured key opens throws.
 */
export function reencryptSecret(payload: string): { payload: string; changed: boolean } {
  if (!needsReencryption(payload)) return { payload, changed: false };
  return { payload: encryptSecret(decryptSecret(payload)), changed: true };
}

export function secretFingerprint(secret: string) {
  const trimmed = String(secret || '').trim();
  if (!trimmed) return '';
  // Hash digest only — no plaintext suffix, so a logged fingerprint reveals
  // nothing about the secret itself.
  return createHash('sha256').update(trimmed).digest('hex').slice(0, 16);
}

export function maskFingerprint(fingerprint: string) {
  // slice(-4) also renders legacy "digest:sufx" fingerprints unchanged.
  return fingerprint ? `...${fingerprint.slice(-4)}` : '';
}

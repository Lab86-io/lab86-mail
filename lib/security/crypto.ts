import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';

function keyMaterial() {
  const raw = process.env.LAB86_MAIL_ENCRYPTION_KEY || process.env.MAIL_OS_ENCRYPTION_KEY || '';
  if (!raw) {
    throw new Error('LAB86_MAIL_ENCRYPTION_KEY is required for encrypted hosted secrets.');
  }
  if (/^[A-Za-z0-9+/=]{43,}$/.test(raw)) {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  }
  return createHash('sha256').update(raw).digest();
}

export function encryptSecret(plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyMaterial(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(payload: string) {
  const [version, ivRaw, tagRaw, ciphertextRaw] = String(payload || '').split('.');
  if (version !== VERSION || !ivRaw || !tagRaw || !ciphertextRaw) {
    throw new Error('Invalid encrypted secret payload.');
  }
  const decipher = createDecipheriv('aes-256-gcm', keyMaterial(), Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
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

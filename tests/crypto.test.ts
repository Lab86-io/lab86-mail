import { describe, expect, test } from 'bun:test';
import { decryptSecret, encryptSecret, maskFingerprint, secretFingerprint } from '../lib/security/crypto';

describe('crypto helpers', () => {
  test('round-trips secrets with a passphrase key', () => {
    const previous = process.env.LAB86_MAIL_ENCRYPTION_KEY;
    process.env.LAB86_MAIL_ENCRYPTION_KEY = 'test-passphrase-for-unit-tests';
    try {
      const payload = encryptSecret('super-secret-token');
      expect(payload.startsWith('v1.')).toBe(true);
      expect(decryptSecret(payload)).toBe('super-secret-token');
    } finally {
      if (previous === undefined) delete process.env.LAB86_MAIL_ENCRYPTION_KEY;
      else process.env.LAB86_MAIL_ENCRYPTION_KEY = previous;
    }
  });
  test('accepts base64-encoded 32-byte keys', () => {
    const previous = process.env.LAB86_MAIL_ENCRYPTION_KEY;
    process.env.LAB86_MAIL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      expect(decryptSecret(encryptSecret('token'))).toBe('token');
    } finally {
      if (previous === undefined) delete process.env.LAB86_MAIL_ENCRYPTION_KEY;
      else process.env.LAB86_MAIL_ENCRYPTION_KEY = previous;
    }
  });
  test('rejects invalid encrypted payloads', () => {
    const previous = process.env.LAB86_MAIL_ENCRYPTION_KEY;
    process.env.LAB86_MAIL_ENCRYPTION_KEY = 'test-passphrase-for-unit-tests';
    try {
      expect(() => decryptSecret('not-a-payload')).toThrow(/Invalid encrypted secret payload/);
    } finally {
      if (previous === undefined) delete process.env.LAB86_MAIL_ENCRYPTION_KEY;
      else process.env.LAB86_MAIL_ENCRYPTION_KEY = previous;
    }
  });
  test('fingerprints secrets without leaking plaintext', () => {
    const fingerprint = secretFingerprint('abc123');
    expect(fingerprint).toHaveLength(16);
    expect(fingerprint).not.toContain('abc');
    expect(maskFingerprint(fingerprint)).toBe(`...${fingerprint.slice(-4)}`);
    expect(maskFingerprint('')).toBe('');
  });
});

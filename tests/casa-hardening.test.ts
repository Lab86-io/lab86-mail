import { describe, expect, test } from 'bun:test';
import { assertPublicHttpUrl, ipv6Groups } from '../lib/attachments/fetch-store';
import { decryptSecret, encryptSecret } from '../lib/security/crypto';
import { sanitizeInternalPath } from '../lib/security/redirect';
import { constantTimeEqual } from '../proxy';

// Fixes of the 2026-09-28 readiness scans (docs/google-verification/security-controls.md).

describe('sanitizeInternalPath refuses control characters (S2)', () => {
  test('a tab or newline cannot turn a path into another host', () => {
    expect(sanitizeInternalPath('/\t/evil.com')).toBe('/');
    expect(sanitizeInternalPath('/\n/evil.com')).toBe('/');
    expect(sanitizeInternalPath('/\r\n/evil.com')).toBe('/');
    expect(sanitizeInternalPath('/\u0000/evil.com')).toBe('/');
    expect(
      new URL(sanitizeInternalPath(decodeURIComponent('/%09/evil.com')), 'https://mail.example').host,
    ).toBe('mail.example');
  });

  test('a percent-encoded tab stays a same-origin path', () => {
    expect(sanitizeInternalPath('/%09/evil.com')).toBe('/%09/evil.com');
    expect(new URL(sanitizeInternalPath('/%09/evil.com'), 'https://mail.example').host).toBe('mail.example');
  });

  test('normal paths with a query and a hash stay', () => {
    expect(sanitizeInternalPath('/settings?tab=mail#accounts')).toBe('/settings?tab=mail#accounts');
  });
});

describe('IPv6 forms of internal addresses (S3)', () => {
  test('ipv6Groups expands short, mapped, and zoned forms', () => {
    expect(ipv6Groups('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Groups('[::ffff:127.0.0.1]')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(ipv6Groups('::ffff:7f00:1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(ipv6Groups('fe80::1%eth0')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Groups('2001:db8::')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(ipv6Groups('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('ipv6Groups rejects malformed addresses', () => {
    expect(ipv6Groups('1::2::3')).toBeNull();
    expect(ipv6Groups('1:2:3')).toBeNull();
    expect(ipv6Groups('::gggg')).toBeNull();
    expect(ipv6Groups('::ffff:999.0.0.1')).toBeNull();
    expect(ipv6Groups('1:2:3:4:5:6:7:8::')).toBeNull();
  });

  test.each([
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a9fe:a9fe]/latest/meta-data',
    'http://[::127.0.0.1]/',
    'http://[64:ff9b::a00:1]/',
    // Local-use NAT64 (RFC 8215): a /96 inside it and a /48 form of 8.8.8.8.
    'http://[64:ff9b:1::a00:1]/',
    'http://[64:ff9b:1:808:8:800::]/',
    'http://[::1]/',
    'http://[::]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[ff02::1]/',
  ])('refuses %s', async (url) => {
    await expect(assertPublicHttpUrl(url)).rejects.toThrow();
  });

  test('allows a public IPv6 address and a mapped public IPv4 address', async () => {
    expect(await assertPublicHttpUrl('http://[2606:4700:4700::1111]/')).toBe(
      'http://[2606:4700:4700::1111]/',
    );
    expect(await assertPublicHttpUrl('http://[::ffff:1.1.1.1]/')).toBe('http://[::ffff:101:101]/');
  });
});

describe('encrypted secrets need the full GCM tag (S6)', () => {
  test('a shortened tag does not decrypt', () => {
    const previous = process.env.LAB86_MAIL_ENCRYPTION_KEY;
    process.env.LAB86_MAIL_ENCRYPTION_KEY = 'casa-hardening-test-key';
    try {
      const payload = encryptSecret('refresh-token');
      expect(decryptSecret(payload)).toBe('refresh-token');
      const parts = payload.split('.');
      const tagIndex = parts.length - 2;
      parts[tagIndex] = Buffer.from(parts[tagIndex], 'base64url').subarray(0, 4).toString('base64url');
      expect(() => decryptSecret(parts.join('.'))).toThrow();
    } finally {
      if (previous === undefined) delete process.env.LAB86_MAIL_ENCRYPTION_KEY;
      else process.env.LAB86_MAIL_ENCRYPTION_KEY = previous;
    }
  });
});

describe('constantTimeEqual (S11)', () => {
  test('matches equal strings only', () => {
    expect(constantTimeEqual('user:pass', 'user:pass')).toBe(true);
    expect(constantTimeEqual('user:pass', 'user:pasS')).toBe(false);
    expect(constantTimeEqual('user:pass', 'user:pas')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('', 'x')).toBe(false);
  });
});

describe('unsigned Nylas webhooks (S10)', () => {
  async function post(env: Record<string, string | undefined>) {
    const { POST } = await import('../app/api/nylas/webhook/route');
    const { NextRequest } = await import('next/server');
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(env)) {
      saved[key] = process.env[key];
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    try {
      // Not JSON: a request that passes the signature check stops at the parse, with no side effect.
      const req = new NextRequest('https://mail.example/api/nylas/webhook', {
        method: 'POST',
        body: 'not json',
      });
      return (await POST(req)).status;
    } finally {
      for (const key of Object.keys(saved)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }

  test('a production build refuses them even with the override', async () => {
    expect(
      await post({
        NYLAS_WEBHOOK_SECRET: undefined,
        LAB86_MAIL_ALLOW_UNVERIFIED_WEBHOOKS: '1',
        NODE_ENV: 'production',
      }),
    ).toBe(503);
  });

  test('local development accepts them only with the override', async () => {
    expect(
      await post({
        NYLAS_WEBHOOK_SECRET: undefined,
        LAB86_MAIL_ALLOW_UNVERIFIED_WEBHOOKS: '1',
        NODE_ENV: 'development',
      }),
    ).toBe(400);
    expect(
      await post({
        NYLAS_WEBHOOK_SECRET: undefined,
        LAB86_MAIL_ALLOW_UNVERIFIED_WEBHOOKS: undefined,
        NODE_ENV: 'development',
      }),
    ).toBe(503);
  });
});

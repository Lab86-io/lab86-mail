import { afterEach, describe, expect, test } from 'bun:test';
import type { NextFetchEvent } from 'next/server';
import { NextRequest } from 'next/server';
import proxy, { isLocalBasicAuthBypassHost, isOfficeServerRoute, shouldRequireBasicAuth } from '../proxy';
import { setProcessEnv } from './tools/env';

const ENV_KEYS = [
  'LAB86_MAIL_DISABLE_BASIC_AUTH',
  'LAB86_MAIL_REQUIRE_BASIC_AUTH',
  'RAILWAY_ENVIRONMENT_NAME',
  'NODE_ENV',
  'LAB86_BASIC_AUTH_USER',
  'LAB86_BASIC_AUTH_PASSWORD',
] as const;

const previousEnv = new Map<string, string | undefined>();

function req(host: string) {
  return new Request('https://example.test/inbox', { headers: { host } });
}

function bearerReq(host: string, token = 'clerk-session-token') {
  return new Request('https://example.test/api/mobile/activity', {
    headers: { host, authorization: `Bearer ${token}` },
  });
}

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    const value = values[key];
    setProcessEnv(key, value);
  }
}

describe('proxy basic-auth bypass guard', () => {
  test('ordinary local development and production do not need a browser challenge', () => {
    for (const nodeEnv of ['development', 'production']) {
      setEnv({ NODE_ENV: nodeEnv });
      expect(shouldRequireBasicAuth(req('localhost:3000'), '/inbox')).toBe(false);
      expect(shouldRequireBasicAuth(req('mail.lab86.io'), '/inbox')).toBe(false);
    }
  });
  test('bypasses only the exact capability-authenticated Office server endpoints', () => {
    setEnv({ LAB86_MAIL_REQUIRE_BASIC_AUTH: '1', NODE_ENV: 'test' });
    for (const path of [
      '/api/office/file-123/callback',
      '/api/office/file-123/content',
      '/api/office/wopi/file-123',
      '/api/office/wopi/file-123/contents',
    ]) {
      expect(isOfficeServerRoute(path)).toBe(true);
      expect(shouldRequireBasicAuth(req('preview.example.test'), path)).toBe(false);
    }
    for (const path of [
      '/api/office',
      '/api/office/file-123',
      '/api/office/file-123/session',
      '/api/office/file-123/content/extra',
      '/api/office/file-123/callback-admin',
      '/api/office/wopi/file-123/admin',
      '/api/office/wopi',
    ]) {
      expect(isOfficeServerRoute(path)).toBe(false);
      expect(shouldRequireBasicAuth(req('preview.example.test'), path)).toBe(true);
    }
  });
  for (const key of ENV_KEYS) previousEnv.set(key, process.env[key]);

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = previousEnv.get(key);
      setProcessEnv(key, value);
    }
  });

  test('recognizes only local tunnel hosts, including port-suffixed forms', () => {
    expect(isLocalBasicAuthBypassHost(req('localhost'))).toBe(true);
    expect(isLocalBasicAuthBypassHost(req('localhost:3000'))).toBe(true);
    expect(isLocalBasicAuthBypassHost(req('127.0.0.1:3000'))).toBe(true);
    expect(isLocalBasicAuthBypassHost(req('[::1]:3000'))).toBe(true);
    expect(isLocalBasicAuthBypassHost(req('::1'))).toBe(true);
    expect(isLocalBasicAuthBypassHost(req('preview.localhost'))).toBe(true);
    expect(isLocalBasicAuthBypassHost(req('albatross.lab86.io'))).toBe(true);
    expect(isLocalBasicAuthBypassHost(req('preview.example.test'))).toBe(false);
    expect(isLocalBasicAuthBypassHost(req('lab86.io'))).toBe(false);
  });

  test('requires basic auth on development hosts unless the dev bypass is enabled and local', () => {
    setEnv({ LAB86_MAIL_REQUIRE_BASIC_AUTH: '1', NODE_ENV: 'test' });
    expect(shouldRequireBasicAuth(req('preview.example.test'), '/inbox')).toBe(true);
    expect(shouldRequireBasicAuth(req('localhost:3000'), '/inbox')).toBe(true);

    setEnv({
      LAB86_MAIL_DISABLE_BASIC_AUTH: '1',
      LAB86_MAIL_REQUIRE_BASIC_AUTH: '1',
      NODE_ENV: 'test',
    });
    expect(shouldRequireBasicAuth(req('localhost:3000'), '/inbox')).toBe(false);
    expect(shouldRequireBasicAuth(req('albatross.lab86.io'), '/inbox')).toBe(false);
    expect(shouldRequireBasicAuth(req('preview.example.test'), '/inbox')).toBe(true);
  });

  test('does not honor the bypass on production, regardless of legacy environment names', () => {
    setEnv({
      LAB86_MAIL_DISABLE_BASIC_AUTH: '1',
      LAB86_MAIL_REQUIRE_BASIC_AUTH: '1',
      NODE_ENV: 'production',
    });
    expect(shouldRequireBasicAuth(req('localhost:3000'), '/inbox')).toBe(true);

    setEnv({
      LAB86_MAIL_DISABLE_BASIC_AUTH: '1',
      LAB86_MAIL_REQUIRE_BASIC_AUTH: '1',
      NODE_ENV: 'production',
      RAILWAY_ENVIRONMENT_NAME: 'development',
    });
    expect(shouldRequireBasicAuth(req('localhost:3000'), '/inbox')).toBe(true);
  });

  test('the proxy lets the right pair through and challenges a wrong or short one', async () => {
    setEnv({
      LAB86_MAIL_REQUIRE_BASIC_AUTH: '1',
      NODE_ENV: 'test',
      LAB86_BASIC_AUTH_USER: 'review',
      LAB86_BASIC_AUTH_PASSWORD: 'a-long-development-password',
    });
    const call = (credential?: string) =>
      proxy(
        new NextRequest('https://preview.example.test/api/mail/corpus/backfill', {
          headers: {
            host: 'preview.example.test',
            ...(credential ? { authorization: `Basic ${btoa(credential)}` } : {}),
          },
        }),
        {} as NextFetchEvent,
      );
    expect((await call('review:a-long-development-password')).status).toBe(200);
    for (const credential of [undefined, 'review:wrong', 'review:a', 'review:a-long-development-password!']) {
      const response = await call(credential);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Basic');
    }
  });

  test('keeps public health checks outside basic auth', () => {
    setEnv({ LAB86_MAIL_REQUIRE_BASIC_AUTH: '1', NODE_ENV: 'test' });
    expect(shouldRequireBasicAuth(req('preview.example.test'), '/api/healthz')).toBe(false);
  });

  test('keeps the Google push routes outside basic auth; Google cannot send it', () => {
    setEnv({ LAB86_MAIL_REQUIRE_BASIC_AUTH: '1', NODE_ENV: 'test' });
    for (const path of ['/api/google/push/gmail', '/api/google/push/calendar', '/api/google/push/drive']) {
      expect(shouldRequireBasicAuth(req('preview.example.test'), path)).toBe(false);
    }
    expect(shouldRequireBasicAuth(req('preview.example.test'), '/api/google/connect')).toBe(true);
  });

  test('lets native Clerk bearer API requests reach Clerk validation', () => {
    setEnv({ LAB86_MAIL_REQUIRE_BASIC_AUTH: '1', NODE_ENV: 'test' });

    expect(shouldRequireBasicAuth(bearerReq('preview.example.test'), '/api/mobile/activity')).toBe(false);
    expect(shouldRequireBasicAuth(bearerReq('preview.example.test'), '/api/tools/list_accounts')).toBe(false);
    expect(shouldRequireBasicAuth(bearerReq('preview.example.test'), '/inbox')).toBe(true);
    expect(shouldRequireBasicAuth(bearerReq('preview.example.test', ''), '/api/mobile/activity')).toBe(true);
    expect(shouldRequireBasicAuth(req('preview.example.test'), '/api/mobile/activity')).toBe(true);
  });
});

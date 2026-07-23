import { afterEach, describe, expect, test } from 'bun:test';
import { isLocalBasicAuthBypassHost, shouldRequireBasicAuth } from '../proxy';

const ENV_KEYS = [
  'LAB86_MAIL_DISABLE_BASIC_AUTH',
  'LAB86_MAIL_REQUIRE_BASIC_AUTH',
  'RAILWAY_ENVIRONMENT_NAME',
  'NODE_ENV',
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
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('proxy basic-auth bypass guard', () => {
  for (const key of ENV_KEYS) previousEnv.set(key, process.env[key]);

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
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
    expect(isLocalBasicAuthBypassHost(req('mail-staging.lab86.io'))).toBe(false);
    expect(isLocalBasicAuthBypassHost(req('lab86.io'))).toBe(false);
  });

  test('requires basic auth on staging hosts unless the dev bypass is enabled and local', () => {
    setEnv({ LAB86_MAIL_REQUIRE_BASIC_AUTH: '1', NODE_ENV: 'test' });
    expect(shouldRequireBasicAuth(req('mail-staging.lab86.io'), '/inbox')).toBe(true);
    expect(shouldRequireBasicAuth(req('localhost:3000'), '/inbox')).toBe(true);

    setEnv({
      LAB86_MAIL_DISABLE_BASIC_AUTH: '1',
      LAB86_MAIL_REQUIRE_BASIC_AUTH: '1',
      NODE_ENV: 'test',
    });
    expect(shouldRequireBasicAuth(req('localhost:3000'), '/inbox')).toBe(false);
    expect(shouldRequireBasicAuth(req('albatross.lab86.io'), '/inbox')).toBe(false);
    expect(shouldRequireBasicAuth(req('mail-staging.lab86.io'), '/inbox')).toBe(true);
  });

  test('does not honor the bypass on production except the Railway development environment', () => {
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
    expect(shouldRequireBasicAuth(req('localhost:3000'), '/inbox')).toBe(false);
  });

  test('keeps public health checks outside basic auth', () => {
    setEnv({ LAB86_MAIL_REQUIRE_BASIC_AUTH: '1', NODE_ENV: 'test' });
    expect(shouldRequireBasicAuth(req('mail-staging.lab86.io'), '/api/healthz')).toBe(false);
  });

  test('lets native Clerk bearer API requests reach Clerk validation', () => {
    setEnv({ LAB86_MAIL_REQUIRE_BASIC_AUTH: '1', NODE_ENV: 'test' });

    expect(shouldRequireBasicAuth(bearerReq('mail-staging.lab86.io'), '/api/mobile/activity')).toBe(false);
    expect(shouldRequireBasicAuth(bearerReq('mail-staging.lab86.io'), '/api/tools/list_accounts')).toBe(
      false,
    );
    expect(shouldRequireBasicAuth(bearerReq('mail-staging.lab86.io'), '/inbox')).toBe(true);
    expect(shouldRequireBasicAuth(bearerReq('mail-staging.lab86.io', ''), '/api/mobile/activity')).toBe(true);
    expect(shouldRequireBasicAuth(req('mail-staging.lab86.io'), '/api/mobile/activity')).toBe(true);
  });
});

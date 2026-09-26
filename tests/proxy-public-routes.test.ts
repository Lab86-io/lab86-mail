import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { NextRequest } from 'next/server';
import { isOfficeServerRoute, isPublicRoute } from '../proxy';

const ROOT = join(import.meta.dir, '..');

// A handler with one of these marks authenticates its caller with something
// other than a Clerk session, so Clerk must not redirect it to sign-in.
const NON_CLERK_AUTH =
  /isInternalCronRequest\(|x-lab86-internal-secret|verifyConsumeToken|verifyWebhook\(|consume\w*OAuthState|x-nylas-signature/;

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...routeFiles(path));
    else if (name === 'route.ts') out.push(path);
  }
  return out;
}

function urlPathFor(file: string) {
  const segments = relative(join(ROOT, 'app'), file).split(sep).slice(0, -1);
  return `/${segments
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .map((segment) => (segment.startsWith('[') ? 'sample-id' : segment))
    .join('/')}`;
}

function isPublic(pathname: string) {
  return isPublicRoute(new NextRequest(`https://mail.lab86.io${pathname}`));
}

describe('Clerk public routes', () => {
  test('every route with non-Clerk authentication is public', () => {
    const blocked = routeFiles(join(ROOT, 'app'))
      .filter((file) => NON_CLERK_AUTH.test(readFileSync(file, 'utf8')))
      .map(urlPathFor)
      .filter((pathname) => !isPublic(pathname) && !isOfficeServerRoute(pathname));
    expect(blocked).toEqual([]);
  });

  test('the routes from the audit are public', () => {
    for (const pathname of [
      '/api/mobile/one-time-codes/consume',
      '/api/mcp/oauth/callback',
      '/api/files/oauth/callback',
      '/api/mail/corpus/backfill',
      '/api/mail/corpus/reconcile',
    ]) {
      expect(isPublic(pathname), pathname).toBe(true);
    }
  });

  test('only board token links are public, not every path that starts with b', () => {
    expect(isPublic('/b/abc123')).toBe(true);
    expect(isPublic('/boards')).toBe(false);
    expect(isPublic('/billing')).toBe(false);
    expect(isPublic('/brief')).toBe(false);
  });

  test('ordinary app routes stay protected', () => {
    expect(isPublic('/api/account')).toBe(false);
    expect(isPublic('/api/mcp/oauth/start')).toBe(false);
    expect(isPublic('/api/files/oauth/start')).toBe(false);
    expect(isPublic('/api/mobile/one-time-codes')).toBe(false);
  });
});

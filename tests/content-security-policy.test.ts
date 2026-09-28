import { afterEach, describe, expect, test } from 'bun:test';
import { NextRequest, NextResponse } from 'next/server';
import {
  buildContentSecurityPolicy,
  clerkFrontendApiOrigin,
  continuesToPage,
  createCspNonce,
  cspHeaderName,
  cspMode,
  isDocumentCspPath,
  isLoopbackHost,
  withMiddlewareRequestHeaders,
} from '../lib/security/csp';
import { documentCspNonce, withFrameNonce } from '../lib/security/frame-nonce';
import {
  API_SECURITY_HEADERS,
  API_SECURITY_HEADERS_SOURCE,
  PERMISSIONS_POLICY,
  SECURITY_HEADERS,
} from '../next.config';
import { applyDocumentCsp } from '../proxy';

// The route matcher that Next.js uses for next.config headers. It ships
// without type declarations.
const { pathToRegexp } = require('next/dist/compiled/path-to-regexp') as {
  pathToRegexp: (path: string, keys: unknown[], options: Record<string, unknown>) => RegExp;
};

const STAGING_ENV = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa('together-sawfish-53.clerk.accounts.dev$')}`,
  NEXT_PUBLIC_CONVEX_URL: 'https://precise-skunk-847.convex.cloud',
  OFFICE_DOCUMENT_SERVER_URL: 'https://documents.example.test/',
};

function directives(policy: string) {
  return Object.fromEntries(
    policy.split('; ').map((part) => {
      const [name, ...sources] = part.split(' ');
      return [name, sources];
    }),
  );
}

describe('content security policy', () => {
  test('builds a nonce policy with every origin the app needs', () => {
    const policy = buildContentSecurityPolicy({ nonce: 'bm9uY2Utb25l', env: STAGING_ENV });
    const map = directives(policy);

    expect(map['script-src']).toEqual([
      "'self'",
      "'nonce-bm9uY2Utb25l'",
      "'strict-dynamic'",
      "'unsafe-eval'",
    ]);
    expect(map['script-src']).not.toContain("'unsafe-inline'");
    expect(map['object-src']).toEqual(["'none'"]);
    expect(map['base-uri']).toEqual(["'self'"]);
    expect(map['frame-ancestors']).toEqual(["'self'"]);
    expect(map['form-action']).toEqual(["'self'", 'https://documents.example.test']);
    expect(map['connect-src']).toEqual(
      expect.arrayContaining([
        'https://precise-skunk-847.convex.cloud',
        'wss://precise-skunk-847.convex.cloud',
        'https://together-sawfish-53.clerk.accounts.dev',
        'https://*.protect.clerk.com:*',
        'https://api.stripe.com',
      ]),
    );
    expect(map['connect-src']).not.toContain('ws://localhost:*');
    expect(map['frame-src']).toEqual(
      expect.arrayContaining([
        'https://documents.example.test',
        'https://www.google.com',
        'https://www.browserbase.com',
        'https://challenges.cloudflare.com',
        'https://js.stripe.com',
      ]),
    );
    expect(map['img-src']).toEqual(["'self'", 'data:', 'blob:', 'https:']);
    expect(map['style-src']).toEqual(["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']);
    expect(map['font-src']).toEqual(["'self'", 'data:', 'https://fonts.gstatic.com']);
    expect(map['worker-src']).toEqual(["'self'", 'blob:']);
    expect(policy.endsWith('; upgrade-insecure-requests')).toBe(true);
    expect(policy).not.toContain('  ');
  });

  test('leaves out origins that are not configured and adds the dev socket in development', () => {
    const policy = buildContentSecurityPolicy({
      nonce: 'bm9uY2UtdHdv',
      env: { OFFICE_DOCUMENT_SERVER_URL: 'not a url', CONVEX_URL: 'ftp://nope.test' },
      development: true,
      upgradeInsecureRequests: false,
    });
    const map = directives(policy);

    expect(map['form-action']).toEqual(["'self'"]);
    expect(map['connect-src']).toContain('ws://localhost:*');
    expect(map['connect-src'].some((source: string) => source.includes('convex'))).toBe(false);
    expect(policy).not.toContain('upgrade-insecure-requests');
    expect(policy).not.toContain('undefined');
  });

  test('reads the Clerk Frontend API host from a publishable key', () => {
    expect(clerkFrontendApiOrigin(`pk_live_${btoa('clerk.mail.lab86.io$')}`)).toBe(
      'https://clerk.mail.lab86.io',
    );
    expect(clerkFrontendApiOrigin(`pk_test_${btoa('x.clerk.accounts.dev$').replace(/=+$/, '')}`)).toBe(
      'https://x.clerk.accounts.dev',
    );
    expect(clerkFrontendApiOrigin(undefined)).toBeNull();
    expect(clerkFrontendApiOrigin('sk_live_abc')).toBeNull();
    expect(clerkFrontendApiOrigin('pk_live_%%%')).toBeNull();
    expect(clerkFrontendApiOrigin('pk_live_a')).toBeNull();
    expect(clerkFrontendApiOrigin(`pk_live_${btoa('not a host$')}`)).toBeNull();
  });

  test('the mode switch defaults to enforce in production and off in development', () => {
    expect(cspMode({ NODE_ENV: 'production' })).toBe('enforce');
    expect(cspMode({ NODE_ENV: 'development' })).toBe('off');
    expect(cspMode({ NODE_ENV: 'production', LAB86_CSP_MODE: ' Report-Only ' })).toBe('report-only');
    expect(cspMode({ NODE_ENV: 'production', LAB86_CSP_MODE: 'off' })).toBe('off');
    expect(cspMode({ NODE_ENV: 'development', LAB86_CSP_MODE: 'enforce' })).toBe('enforce');
    expect(cspMode({ NODE_ENV: 'production', LAB86_CSP_MODE: 'typo' })).toBe('enforce');
    expect(cspHeaderName('enforce')).toBe('Content-Security-Policy');
    expect(cspHeaderName('report-only')).toBe('Content-Security-Policy-Report-Only');
  });

  test('makes a fresh 128-bit nonce each time', () => {
    const first = createCspNonce();
    const second = createCspNonce();
    expect(first).not.toBe(second);
    expect(atob(first)).toHaveLength(16);
  });

  test('page paths get a policy; API routes and the Clerk proxy do not', () => {
    expect(isDocumentCspPath('/')).toBe(true);
    expect(isDocumentCspPath('/settings')).toBe(true);
    expect(isDocumentCspPath('/apiary')).toBe(true);
    expect(isDocumentCspPath('/api')).toBe(false);
    expect(isDocumentCspPath('/api/healthz')).toBe(false);
    expect(isDocumentCspPath('/__clerk/v1/client')).toBe(false);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('app.localhost')).toBe(true);
    expect(isLoopbackHost('mail.lab86.io')).toBe(false);
  });

  test('forwards request headers to the page render and keeps headers Clerk already forwarded', () => {
    const fresh = NextResponse.next();
    withMiddlewareRequestHeaders(fresh, new Headers({ cookie: 'a=1', accept: 'text/html' }), {
      'X-Nonce': 'n1',
    });
    expect(fresh.headers.get('x-middleware-override-headers')?.split(',').sort()).toEqual([
      'accept',
      'cookie',
      'x-nonce',
    ]);
    expect(fresh.headers.get('x-middleware-request-cookie')).toBe('a=1');
    expect(fresh.headers.get('x-middleware-request-x-nonce')).toBe('n1');

    const decorated = NextResponse.next({
      request: { headers: new Headers({ 'x-clerk-auth-status': 'signed-in' }) },
    });
    withMiddlewareRequestHeaders(decorated, new Headers({ cookie: 'ignored' }), { 'x-nonce': 'n2' });
    expect(decorated.headers.get('x-middleware-override-headers')).toBe('x-clerk-auth-status,x-nonce');
    expect(decorated.headers.get('x-middleware-request-cookie')).toBeNull();
    // A second call does not list a key twice.
    withMiddlewareRequestHeaders(decorated, new Headers(), { 'x-nonce': 'n3' });
    expect(decorated.headers.get('x-middleware-override-headers')).toBe('x-clerk-auth-status,x-nonce');
    expect(decorated.headers.get('x-middleware-request-x-nonce')).toBe('n3');

    expect(continuesToPage(NextResponse.next())).toBe(true);
    expect(continuesToPage(NextResponse.rewrite(new URL('https://mail.lab86.io/x')))).toBe(true);
    expect(continuesToPage(NextResponse.redirect(new URL('https://mail.lab86.io/sign-in')))).toBe(false);
  });
});

describe('proxy page policy', () => {
  const previous = { mode: process.env.LAB86_CSP_MODE };
  afterEach(() => {
    if (previous.mode === undefined) delete process.env.LAB86_CSP_MODE;
    else process.env.LAB86_CSP_MODE = previous.mode;
  });

  function page(path: string) {
    return new NextRequest(`https://mail.lab86.io${path}`, { headers: { accept: 'text/html' } });
  }

  test('enforce mode sends the policy and hands the same nonce to the page render', () => {
    process.env.LAB86_CSP_MODE = 'enforce';
    const response = applyDocumentCsp(page('/settings'), NextResponse.next());
    const policy = response.headers.get('content-security-policy') || '';
    const nonce = response.headers.get('x-middleware-request-x-nonce') || '';

    expect(nonce.length).toBeGreaterThan(16);
    expect(policy).toContain(`'nonce-${nonce}'`);
    expect(policy).toContain('upgrade-insecure-requests');
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(policy);
    expect(response.headers.get('x-middleware-request-accept')).toBe('text/html');
  });

  test('report-only mode sends the report-only header and no enforced policy', () => {
    process.env.LAB86_CSP_MODE = 'report-only';
    const response = applyDocumentCsp(page('/'), NextResponse.next());

    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(response.headers.get('content-security-policy-report-only')).toContain("'strict-dynamic'");
    expect(response.headers.get('x-middleware-request-content-security-policy-report-only')).toBeTruthy();
  });

  test('off mode, API routes, and redirects get no request override', () => {
    process.env.LAB86_CSP_MODE = 'off';
    expect(
      applyDocumentCsp(page('/'), NextResponse.next()).headers.get('content-security-policy'),
    ).toBeNull();

    process.env.LAB86_CSP_MODE = 'enforce';
    const api = applyDocumentCsp(page('/api/healthz'), NextResponse.next());
    expect(api.headers.get('content-security-policy')).toBeNull();
    expect(api.headers.get('x-middleware-request-x-nonce')).toBeNull();

    const redirect = applyDocumentCsp(
      page('/'),
      NextResponse.redirect(new URL('https://mail.lab86.io/sign-in')),
    );
    expect(redirect.headers.get('content-security-policy')).toBeTruthy();
    expect(redirect.headers.get('x-middleware-override-headers')).toBeNull();

    // Response.redirect() headers are read-only; the proxy still returns it.
    const frozen = Response.redirect('https://mail.lab86.io/sign-in', 307);
    expect(applyDocumentCsp(page('/'), frozen)).toBe(frozen);
  });

  test('a plain-HTTP loopback host gets no upgrade-insecure-requests', () => {
    process.env.LAB86_CSP_MODE = 'enforce';
    const response = applyDocumentCsp(new NextRequest('http://localhost:3000/'), NextResponse.next());
    expect(response.headers.get('content-security-policy')).not.toContain('upgrade-insecure-requests');
  });
});

describe('static security headers', () => {
  test('keep nosniff, framing, referrer, HSTS, and a narrow permissions policy', () => {
    const map = Object.fromEntries(SECURITY_HEADERS.map((header) => [header.key, header.value]));
    expect(map['X-Content-Type-Options']).toBe('nosniff');
    expect(map['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(map['Strict-Transport-Security']).toContain('max-age=31536000');
    expect(map['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(map['Permissions-Policy']).toBe(PERMISSIONS_POLICY);
    expect(PERMISSIONS_POLICY).toContain('camera=()');
    expect(PERMISSIONS_POLICY).toContain('microphone=(self)');
    expect(PERMISSIONS_POLICY).toContain('geolocation=(self)');
    // Delegated to the editor, live-view, Stripe, and Clerk frames.
    for (const feature of ['clipboard', 'fullscreen', 'payment', 'publickey-credentials']) {
      expect(PERMISSIONS_POLICY).not.toContain(feature);
    }
    // The page policy comes from proxy.ts, not from a static header.
    expect(map['Content-Security-Policy']).toBeUndefined();
    expect(API_SECURITY_HEADERS).toEqual([
      { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
    ]);
  });

  test('the static API policy skips the routes that send a complete policy of their own', () => {
    // Next.js keeps a header that is already on the response, so a static
    // policy on these routes would replace their sandbox policy.
    const matches = pathToRegexp(API_SECURITY_HEADERS_SOURCE, [], { strict: true, delimiter: '/' });
    expect(matches.test('/api/healthz')).toBe(true);
    expect(matches.test('/api/mail/threads')).toBe(true);
    expect(matches.test('/api/albatross/work/w1')).toBe(true);
    expect(matches.test('/api/attachments/m1/a1')).toBe(false);
    expect(matches.test('/api/albatross/plan/p1/artifact')).toBe(false);
  });
});

describe('srcdoc frame nonce', () => {
  const NONCE = 'bm9uY2UtdGhyZWU=';

  test('puts the nonce on every script and replaces an older nonce', () => {
    const html = `<html><head><script>a()</script></head><body><SCRIPT id="x" nonce="old">b()</SCRIPT><script src="c.js" nonce='o'></script></body></html>`;
    const out = withFrameNonce(html, NONCE);

    expect(out.match(new RegExp(`nonce="${NONCE}"`, 'g'))).toHaveLength(3);
    expect(out).not.toContain('nonce="old"');
    expect(out).not.toContain("nonce='o'");
    expect(out).toContain(`<script id="x" nonce="${NONCE}">b()</SCRIPT>`);
  });

  test('handles nested srcdoc documents as documents of their own', () => {
    const widget = '<p>1 < 2 & "q"</p><script>go()</script>';
    const escaped = widget
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const html = `<body><iframe sandbox="allow-scripts" srcdoc="${escaped}"></iframe><iframe srcdoc='<script>x()</script>'></iframe></body>`;
    const out = withFrameNonce(html, NONCE);

    const nested = [...out.matchAll(/srcdoc="([^"]*)"/g)].map((match) =>
      match[1]
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&'),
    );
    expect(nested).toEqual([
      `<p>1 < 2 & "q"</p><script nonce="${NONCE}">go()</script>`,
      `<script nonce="${NONCE}">x()</script>`,
    ]);
    // The outer pass does not add a script of its own for nested frames.
    expect(out.startsWith('<body><iframe')).toBe(true);
  });

  test('replaces inline image error handlers with one nonce script at the start', () => {
    const html = `<html><head><title>t</title></head><body><header class="hero"><img src="a.jpg" data-fallbacks='["b.jpg"]' onerror="(function(img){})(this)"></header><img class="mark" src="m.png" onerror='this.style.display="none"'></body></html>`;
    const out = withFrameNonce(html, NONCE);

    expect(out).not.toMatch(/\sonerror\s*=/);
    expect(out.match(/<img[^>]*data-lab86-onerror/g)).toHaveLength(2);
    expect(out).toContain(`<head><script id="lab86-image-fallback-js" nonce="${NONCE}">`);
    expect(out.indexOf('lab86-image-fallback-js')).toBeLessThan(out.indexOf('<img'));

    expect(withFrameNonce('<html><body><img src="a" onerror="x()"></body></html>', NONCE)).toContain(
      `<html><script id="lab86-image-fallback-js" nonce="${NONCE}">`,
    );
    expect(
      withFrameNonce('<img src="a" onerror="x()">', NONCE).startsWith('<script id="lab86-image-fallback-js"'),
    ).toBe(true);
  });

  test('leaves the document unchanged with no valid nonce', () => {
    const html = '<script>a()</script><img onerror="x()">';
    expect(withFrameNonce(html, '')).toBe(html);
    expect(withFrameNonce(html, 'short')).toBe(html);
    expect(withFrameNonce(html, 'bad"nonce<value>')).toBe(html);
    expect(withFrameNonce('', NONCE)).toBe('');
  });

  test('reads the page nonce from the nonce property, then the attribute', () => {
    const withProperty = { querySelector: () => ({ nonce: 'from-property', getAttribute: () => '' }) };
    const withAttribute = { querySelector: () => ({ nonce: '', getAttribute: () => 'from-attribute' }) };
    const withNone = { querySelector: () => null };

    expect(documentCspNonce(withProperty as any)).toBe('from-property');
    expect(documentCspNonce(withAttribute as any)).toBe('from-attribute');
    expect(documentCspNonce(withNone as any)).toBe('');
    expect(documentCspNonce(undefined)).toBe('');
  });
});

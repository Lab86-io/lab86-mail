// Content-Security-Policy for HTML documents. proxy.ts makes a nonce for each
// request, builds the policy here, and hands both to Next.js through request
// headers: Next.js puts the nonce on its own scripts, and the root layout
// passes it to Clerk and next-themes. docs/content-security-policy.md gives the
// reason for each origin.
//
// LAB86_CSP_MODE is the rollback switch:
//   enforce      send Content-Security-Policy (default in production)
//   report-only  send Content-Security-Policy-Report-Only
//   off          send no policy header (the default for `next dev`)

export type CspMode = 'enforce' | 'report-only' | 'off';

export const CSP_NONCE_HEADER = 'x-nonce';

export function cspMode(env: Record<string, string | undefined> = process.env): CspMode {
  const raw = (env.LAB86_CSP_MODE || '').trim().toLowerCase();
  if (raw === 'enforce' || raw === 'report-only' || raw === 'off') return raw;
  // `next dev` keeps no policy unless the mode is set on purpose.
  return env.NODE_ENV === 'production' ? 'enforce' : 'off';
}

export function cspHeaderName(mode: Exclude<CspMode, 'off'>) {
  return mode === 'report-only' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
}

/** A fresh base64 nonce with 128 random bits. */
export function createCspNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/** API routes and the Clerk proxy return no HTML page; they get no page policy. */
export function isDocumentCspPath(pathname: string) {
  return !(pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/__clerk'));
}

function origin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The Clerk Frontend API origin that a publishable key names (pk_live_/pk_test_ + base64 "host$"). */
export function clerkFrontendApiOrigin(publishableKey: string | undefined) {
  const match = /^pk_(?:live|test)_([A-Za-z0-9+/=_-]+)$/.exec((publishableKey || '').trim());
  if (!match) return null;
  let decoded: string;
  try {
    decoded = atob(match[1].replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  const host = decoded.replace(/\$$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? `https://${host}` : null;
}

function convexOrigins(url: string | undefined) {
  const https = origin(url);
  if (!https) return [];
  return [https, https.replace(/^http/, 'ws')];
}

export interface CspOptions {
  nonce: string;
  env?: Record<string, string | undefined>;
  // Adds the HMR socket that `next dev` needs. (React's dev eval is already
  // allowed: script-src holds 'unsafe-eval' for the spreadsheet engine.)
  development?: boolean;
  // Leave out upgrade-insecure-requests for plain-HTTP local hosts.
  upgradeInsecureRequests?: boolean;
}

export function buildContentSecurityPolicy(options: CspOptions) {
  const env = options.env ?? process.env;
  const clerk = clerkFrontendApiOrigin(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const office = origin(env.OFFICE_DOCUMENT_SERVER_URL);
  const convex = convexOrigins(env.NEXT_PUBLIC_CONVEX_URL || env.CONVEX_URL);
  const present = (...values: Array<string | null | undefined | false>) =>
    values.filter((value): value is string => Boolean(value));

  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    [
      'script-src',
      present(
        "'self'",
        `'nonce-${options.nonce}'`,
        "'strict-dynamic'",
        // The Odoo spreadsheet engine (o-spreadsheet and Owl) compiles its
        // templates and formulas with new Function().
        "'unsafe-eval'",
      ),
    ],
    // Clerk injects runtime CSS-in-JS; React renders style attributes; the
    // sandboxed brief documents load Google Fonts stylesheets.
    ['style-src', ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']],
    // Mail bodies, sender logos, avatars, and daily art come from any HTTPS host.
    ['img-src', ["'self'", 'data:', 'blob:', 'https:']],
    ['font-src', ["'self'", 'data:', 'https://fonts.gstatic.com']],
    [
      'connect-src',
      present(
        "'self'",
        ...convex,
        clerk,
        'https://clerk-telemetry.com',
        'https://*.clerk-telemetry.com',
        'https://*.protect.clerk.com:*',
        'https://img.clerk.com',
        // Clerk billing runs on Stripe.
        'https://api.stripe.com',
        'https://maps.googleapis.com',
        'data:',
        'blob:',
        options.development && 'ws://localhost:*',
      ),
    ],
    [
      'frame-src',
      present(
        "'self'",
        'blob:',
        office,
        // Calendar event maps.
        'https://www.google.com',
        // Shared browser live view.
        'https://www.browserbase.com',
        'https://*.browserbase.com',
        // Clerk bot and fraud protection, and Stripe for Clerk billing.
        'https://challenges.cloudflare.com',
        'https://*.protect.clerk.com',
        'https://js.stripe.com',
        'https://*.js.stripe.com',
        'https://hooks.stripe.com',
      ),
    ],
    ['worker-src', ["'self'", 'blob:']],
    ['media-src', ["'self'", 'data:', 'blob:']],
    ['manifest-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    // The Collabora editor opens through a form POST into its frame.
    ['form-action', present("'self'", office)],
    ['frame-ancestors', ["'self'"]],
  ];
  const parts = directives.map(([name, sources]) => `${name} ${[...new Set(sources)].join(' ')}`);
  if (options.upgradeInsecureRequests !== false) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

/** Plain-HTTP loopback hosts cannot upgrade their own requests to HTTPS. */
export function isLoopbackHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

/**
 * Adds request headers for the page render to a middleware response. This is
 * what NextResponse.next({ request: { headers } }) does, but it also keeps
 * the headers that Clerk already forwarded on the same response.
 */
export function withMiddlewareRequestHeaders(
  response: Response,
  requestHeaders: Headers,
  extra: Record<string, string>,
) {
  const OVERRIDE = 'x-middleware-override-headers';
  const PREFIX = 'x-middleware-request-';
  const existing = response.headers.get(OVERRIDE);
  const keys = existing ? existing.split(',').filter(Boolean) : [];
  if (!existing) {
    for (const [key, value] of requestHeaders) {
      keys.push(key);
      response.headers.set(`${PREFIX}${key}`, value);
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    const name = key.toLowerCase();
    if (!keys.includes(name)) keys.push(name);
    response.headers.set(`${PREFIX}${name}`, value);
  }
  response.headers.set(OVERRIDE, keys.join(','));
  return response;
}

/** True for a middleware response that lets the request go on to a page. */
export function continuesToPage(response: Response) {
  return response.headers.get('x-middleware-next') === '1' || response.headers.has('x-middleware-rewrite');
}

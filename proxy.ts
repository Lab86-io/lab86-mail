import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import type { NextFetchEvent } from 'next/server';
import { NextRequest, NextResponse } from 'next/server';
import { isStagingRuntime } from './lib/hosted/controls';

const hasClerkKeys = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);

const isPublicRoute = createRouteMatcher([
  '/__clerk(.*)',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/healthz',
  '/api/clerk/webhook',
  '/api/nylas/callback',
  '/api/nylas/webhook',
  '/api/billing/webhook',
  '/privacy',
  '/terms',
  '/support',
  '/pricing',
  // Public read-only board links: the token in the path is the credential.
  '/b(.*)',
]);

const passthroughProxy = (_req: NextRequest) => NextResponse.next();

const protectedProxy = clerkMiddleware(
  async (auth, req) => {
    if (!isPublicRoute(req)) {
      await auth.protect({
        unauthenticatedUrl: new URL('/sign-in', req.url).toString(),
      });
    }
    return NextResponse.next();
  },
  {
    frontendApiProxy: {
      enabled: Boolean(process.env.NEXT_PUBLIC_CLERK_PROXY_URL && isStagingRuntime()),
    },
  },
);

export default function proxy(req: NextRequest, event: NextFetchEvent) {
  const basicAuth = basicAuthOrNext(req);
  if (basicAuth.status !== 200) return basicAuth;

  // Staging basic auth makes browsers attach `Authorization: Basic ...` to every
  // same-origin request. Clerk rejects requests that carry both `Origin` and
  // `Authorization`, and its server SDK prefers the header over the session
  // cookie, so the credential must not reach Clerk after it has been verified.
  let forwarded = req;
  const [scheme] = (req.headers.get('authorization') || '').split(/\s+/, 2);
  if (scheme?.toLowerCase() === 'basic') {
    const headers = new Headers(req.headers);
    headers.delete('authorization');
    forwarded = new NextRequest(req, { headers, duplex: 'half' } as ConstructorParameters<
      typeof NextRequest
    >[1]);
  }

  return hasClerkKeys ? protectedProxy(forwarded, event) : passthroughProxy(forwarded);
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/__clerk/(.*)',
    '/(api|trpc)(.*)',
  ],
};

function basicAuthOrNext(req: Request) {
  const url = new URL(req.url);
  if (!shouldRequireBasicAuth(req, url.pathname)) return NextResponse.next();

  const user = process.env.STAGING_BASIC_AUTH_USER || '';
  const password = process.env.STAGING_BASIC_AUTH_PASSWORD || '';
  if (!user || !password) {
    return new NextResponse('Staging basic auth is not configured.', { status: 503 });
  }

  const authHeader = req.headers.get('authorization') || '';
  const [scheme, encoded] = authHeader.split(/\s+/, 2);
  if (scheme?.toLowerCase() === 'basic' && encoded) {
    const decoded = decodeBase64(encoded);
    if (decoded === `${user}:${password}`) return NextResponse.next();
  }

  return new NextResponse('Authentication required.', {
    status: 401,
    headers: {
      'www-authenticate': 'Basic realm="lab86-mail staging", charset="UTF-8"',
    },
  });
}

function shouldRequireBasicAuth(req: Request, pathname: string) {
  if (!isStagingRuntime(req.headers.get('host'))) return false;
  if (pathname === '/api/healthz') return false;
  if (pathname === '/api/clerk/webhook') return false;
  // Convex validates Clerk JWTs by fetching the issuer's OIDC discovery
  // document server-to-server — it can never present staging basic auth.
  // With the proxy URL as the issuer, /__clerk must be reachable bare, or
  // every browser live query fails ("Auth provider discovery ... 401").
  // The Clerk Frontend API behind it is public by design.
  if (pathname.startsWith('/__clerk')) return false;
  // Nylas deliveries authenticate via HMAC signature in the route handler;
  // the challenge GET and signed POSTs come from Nylas servers, which can
  // never satisfy staging basic auth.
  if (pathname === '/api/nylas/webhook') return false;
  if (pathname === '/api/billing/webhook') return false;
  return true;
}

function decodeBase64(value: string) {
  try {
    return atob(value);
  } catch {
    return '';
  }
}

import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { isStagingRuntime } from './lib/hosted/controls';

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/healthz',
  '/api/clerk/webhook',
  '/api/nylas/callback',
  '/api/billing/webhook',
  '/privacy',
  '/terms',
  '/support',
]);

const hasClerkKeys = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
const isDevRuntime = process.env.NODE_ENV === 'development';

const passthroughProxy = (req: Request) => {
  const basicAuth = basicAuthOrNext(req);
  if (basicAuth.status !== 200) return basicAuth;
  const pathname = new URL(req.url).pathname;
  if (!hasClerkKeys && !isDevRuntime && pathname !== '/api/healthz') {
    return new NextResponse('Authentication is not configured.', { status: 503 });
  }
  return NextResponse.next();
};

const protectedProxy = clerkMiddleware(
  async (auth, req) => {
    const basicAuth = basicAuthOrNext(req);
    if (basicAuth.status !== 200) return basicAuth;
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

export default hasClerkKeys ? protectedProxy : passthroughProxy;

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

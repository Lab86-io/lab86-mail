import type { NextConfig } from 'next';

// NEXT_PUBLIC_CLERK_PROXY_URL is baked into the CLIENT bundle by Clerk's SDK
// at build time, bypassing every runtime guard. If it points at a different
// origin than the app being built (e.g. the staging proxy URL copied into the
// production environment), every sign-in dies on CORS with an empty page.
// Fail the build loudly instead of shipping that.
const clerkProxyUrl = process.env.NEXT_PUBLIC_CLERK_PROXY_URL || '';
const publicUrl =
  process.env.LAB86_MAIL_PUBLIC_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  `http://localhost:${process.env.PORT || '3000'}`;
if (clerkProxyUrl.startsWith('http') && publicUrl.startsWith('http')) {
  const proxyOrigin = new URL(clerkProxyUrl).origin;
  const appOrigin = new URL(publicUrl).origin;
  if (proxyOrigin !== appOrigin) {
    throw new Error(
      `NEXT_PUBLIC_CLERK_PROXY_URL (${proxyOrigin}) does not match the app origin (${appOrigin}). ` +
        'Clerk JS would be loaded cross-origin and blocked by CORS. ' +
        'Fix or remove the variable in this environment before building.',
    );
  }
}

// Browser features the app uses: the microphone (voice capture) and the
// location (a capture can send it with consent). Clipboard, fullscreen,
// payment, and passkeys keep their browser defaults, because the Collabora,
// live-view, Stripe, and Clerk frames get them through their allow attribute.
export const PERMISSIONS_POLICY = [
  'camera=()',
  'microphone=(self)',
  'geolocation=(self)',
  'display-capture=()',
  'usb=()',
  'serial=()',
  'hid=()',
  'midi=()',
  'magnetometer=()',
  'gyroscope=()',
  'accelerometer=()',
  'browsing-topics=()',
].join(', ');

// Response security headers for production builds (staging and production).
// The page Content-Security-Policy comes from proxy.ts, because it needs a
// fresh nonce for each request (lib/security/csp.ts). X-Frame-Options keeps
// the framing rule when LAB86_CSP_MODE is report-only or off. The native apps
// load the app as a top-level page.
export const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: PERMISSIONS_POLICY },
];

// API responses get no page policy from proxy.ts. This one only limits
// framing. Next.js keeps a header that is already on the response and drops
// the route's own copy, so the routes that serve HTML with a complete policy
// of their own (attachments, plan artifacts) must not match this source.
export const API_SECURITY_HEADERS_SOURCE = '/api/:path((?!attachments/|albatross/plan/).*)';
export const API_SECURITY_HEADERS = [{ key: 'Content-Security-Policy', value: "frame-ancestors 'self'" }];

const config: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ['lab86.tail478321.ts.net', 'albatross.lab86.io'],
  experimental: {
    serverActions: {
      bodySizeLimit: '4mb',
    },
  },
  serverExternalPackages: ['jsdom', '@napi-rs/canvas', 'pdfjs-dist'],
  outputFileTracingIncludes: {
    '/*': [
      './lib/documents/spreadsheet-worker.mjs',
      './lib/documents/grid-workbook.mjs',
      './node_modules/@odoo/owl/dist/owl.iife.js',
      './node_modules/@odoo/o-spreadsheet/dist/o_spreadsheet.iife.js',
    ],
  },
  // Long-running SSE responses
  poweredByHeader: false,
  async headers() {
    // `next dev` previews (localhost, tailnet) keep no HSTS or frame rules.
    if (process.env.NODE_ENV !== 'production') return [];
    return [
      { source: '/:path*', headers: SECURITY_HEADERS },
      { source: API_SECURITY_HEADERS_SOURCE, headers: API_SECURITY_HEADERS },
    ];
  },
};

export default config;

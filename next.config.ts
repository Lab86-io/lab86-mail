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

// Response security headers for production builds (staging and production).
// The CSP holds frame-ancestors only: a script policy would break Clerk,
// Convex, and the Collabora host. Only this origin may frame the app; the app
// itself frames Collabora and sandboxed srcdoc documents, which this does not
// affect. The native apps load the app as a top-level page.
export const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
];

const config: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ['lab86.tail478321.ts.net', 'albatross.lab86.io'],
  experimental: {
    serverActions: {
      bodySizeLimit: '4mb',
    },
  },
  serverExternalPackages: ['mailparser', 'jsdom', '@napi-rs/canvas', 'pdfjs-dist'],
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
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

export default config;

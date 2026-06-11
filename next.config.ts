import type { NextConfig } from 'next';

// NEXT_PUBLIC_CLERK_PROXY_URL is baked into the CLIENT bundle by Clerk's SDK
// at build time, bypassing every runtime guard. If it points at a different
// origin than the app being built (e.g. the staging proxy URL copied into the
// production environment), every sign-in dies on CORS with an empty page.
// Fail the build loudly instead of shipping that.
const clerkProxyUrl = process.env.NEXT_PUBLIC_CLERK_PROXY_URL || '';
const publicUrl = process.env.LAB86_MAIL_PUBLIC_URL || process.env.NEXT_PUBLIC_APP_URL || '';
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

const config: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ['lab86.tail478321.ts.net'],
  experimental: {
    serverActions: {
      bodySizeLimit: '4mb',
    },
  },
  serverExternalPackages: ['@seald-io/nedb', 'mailparser'],
  // Long-running SSE responses
  poweredByHeader: false,
};

export default config;

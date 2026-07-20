import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clerkFrontendAPIHostFromValues, parseEnv, xcconfigValue } from './ios-config';

const root = process.cwd();
const envPath = path.join(root, '.env.local');
if (!existsSync(envPath)) throw new Error(`Missing ${envPath}`);
const env = parseEnv(readFileSync(envPath, 'utf8'));
const apiURL = env.get('LAB86_MAIL_PUBLIC_URL') || 'https://mail.lab86.io';
const clerkKey = env.get('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY') || '';
const convexURL = env.get('NEXT_PUBLIC_CONVEX_URL') || '';
const clerkProxy = env.get('NEXT_PUBLIC_CLERK_PROXY_URL') || '';
const clerkHost = clerkFrontendAPIHostFromValues({
  explicitHost: env.get('CLERK_FRONTEND_API_HOST'),
  proxyURL: clerkProxy,
  publishableKey: clerkKey,
});
const missing = [
  !clerkKey && 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  !convexURL && 'NEXT_PUBLIC_CONVEX_URL',
].filter(Boolean);
if (missing.length) throw new Error(`Missing iOS configuration: ${missing.join(', ')}`);

const destination = path.join(root, 'apps/ios/Config/Local.xcconfig');
writeFileSync(
  destination,
  [
    '// Generated from .env.local by scripts/configure-ios.ts. Do not commit.',
    `LAB86_API_BASE_URL = ${xcconfigValue(apiURL)}`,
    `CLERK_PUBLISHABLE_KEY = ${clerkKey}`,
    `CONVEX_DEPLOYMENT_URL = ${xcconfigValue(convexURL)}`,
    `CLERK_FRONTEND_API_HOST = ${clerkHost}`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);
console.log(`Configured ${path.relative(root, destination)} without printing credentials.`);

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  aasaIncludesApplication,
  clerkFrontendAPIHostFromValues,
  iosApplicationIdentifier,
  parseEnv,
} from './ios-config';

const root = process.cwd();
const envPath = path.join(root, '.env.local');
if (!existsSync(envPath)) throw new Error(`Missing ${envPath}`);

const env = parseEnv(readFileSync(envPath, 'utf8'));
const clerkHost = clerkFrontendAPIHostFromValues({
  explicitHost: env.get('CLERK_FRONTEND_API_HOST'),
  proxyURL: env.get('NEXT_PUBLIC_CLERK_PROXY_URL'),
  publishableKey: env.get('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'),
});
if (!clerkHost) {
  throw new Error('Could not determine the Clerk Frontend API host for the iOS associated domain.');
}

const projectSource = readFileSync(path.join(root, 'apps/ios/project.yml'), 'utf8');
const applicationIdentifier = iosApplicationIdentifier(projectSource);
if (!applicationIdentifier) {
  throw new Error('Could not determine DEVELOPMENT_TEAM and PRODUCT_BUNDLE_IDENTIFIER from project.yml.');
}

async function verify(url: URL, label: string) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
    },
    redirect: 'follow',
  });
  const source = await response.text();
  if (!response.ok || !aasaIncludesApplication(source, applicationIdentifier)) {
    throw new Error(
      `${label} does not associate ${applicationIdentifier}. In Clerk Dashboard > Native applications, enable the Native API and add App ID Prefix ${applicationIdentifier.split('.')[0]} with Bundle ID ${applicationIdentifier.slice(applicationIdentifier.indexOf('.') + 1)}.`,
    );
  }
}

await verify(
  new URL(`https://${clerkHost}/.well-known/apple-app-site-association`),
  `Clerk AASA at ${clerkHost}`,
);
await verify(
  new URL(`https://app-site-association.cdn-apple.com/a/v1/${clerkHost}`),
  `Apple associated-domains CDN for ${clerkHost}`,
);

console.log(`Verified native Clerk association for ${applicationIdentifier} through Clerk and Apple.`);

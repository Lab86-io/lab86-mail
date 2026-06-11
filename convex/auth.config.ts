import type { AuthConfig } from 'convex/server';

const clerkIssuer = process.env.CLERK_JWT_ISSUER_DOMAIN;

if (!clerkIssuer) {
  console.warn('CLERK_JWT_ISSUER_DOMAIN is not set; Convex authenticated client queries are disabled.');
}

export default {
  providers: clerkIssuer
    ? [
        {
          domain: clerkIssuer,
          applicationID: 'convex',
        },
      ]
    : [],
} satisfies AuthConfig;

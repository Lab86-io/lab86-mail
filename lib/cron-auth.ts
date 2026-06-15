import type { NextRequest } from 'next/server';

// Shared gate for internal cron routes called by Convex scheduled actions. The
// caller proves itself with the same shared secret Convex holds in its env.
export function isInternalCronRequest(req: NextRequest): boolean {
  const expected = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  if (!expected) return false;
  const provided =
    req.headers.get('x-lab86-internal-secret') ||
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    '';
  return provided === expected;
}

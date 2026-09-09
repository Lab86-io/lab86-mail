import { ConvexHttpClient } from 'convex/browser';
import { api } from '@/convex/_generated/api';
import { convexInternalSecret, convexUrl, isConvexConfigured } from './env';

let client: ConvexHttpClient | null = null;

export { api };

function createClient(signal?: AbortSignal) {
  if (!isConvexConfigured()) {
    throw new Error('Convex is not configured. Set NEXT_PUBLIC_CONVEX_URL and CONVEX_DEPLOYMENT.');
  }
  return new ConvexHttpClient(convexUrl(), {
    logger: false,
    skipConvexDeploymentUrlCheck: convexUrl().startsWith('http://127.0.0.1'),
    ...(signal
      ? { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, signal }) }
      : {}),
  });
}

export function requireConvexClient() {
  if (!isConvexConfigured())
    throw new Error('Convex is not configured. Set NEXT_PUBLIC_CONVEX_URL and CONVEX_DEPLOYMENT.');
  if (!client) client = createClient();
  return client;
}

export function convexArgs<T extends Record<string, unknown>>(args: T): T & { internalSecret?: string } {
  const internalSecret = convexInternalSecret();
  return internalSecret ? { ...args, internalSecret } : args;
}

export async function convexQuery<T>(
  fn: any,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  // A scoped client avoids attaching one user's cancellation to the shared client.
  const scoped = signal ? createClient(signal) : requireConvexClient();
  return (await scoped.query(fn, convexArgs(args))) as T;
}

export async function convexMutation<T>(fn: any, args: Record<string, unknown>): Promise<T> {
  return (await requireConvexClient().mutation(fn, convexArgs(args))) as T;
}

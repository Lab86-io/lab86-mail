import { ConvexHttpClient } from 'convex/browser';
import { api } from '@/convex/_generated/api';
import { convexInternalSecret, convexUrl, isConvexConfigured } from './env';

let client: ConvexHttpClient | null = null;

export { api };

export function requireConvexClient() {
  if (!isConvexConfigured()) {
    throw new Error('Convex is not configured. Set NEXT_PUBLIC_CONVEX_URL and CONVEX_DEPLOYMENT.');
  }
  if (!client) {
    client = new ConvexHttpClient(convexUrl(), {
      logger: false,
      skipConvexDeploymentUrlCheck: convexUrl().startsWith('http://127.0.0.1'),
    });
  }
  return client;
}

export function convexArgs<T extends Record<string, unknown>>(args: T): T & { internalSecret?: string } {
  const internalSecret = convexInternalSecret();
  return internalSecret ? { ...args, internalSecret } : args;
}

export async function convexQuery<T>(fn: any, args: Record<string, unknown>): Promise<T> {
  return (await requireConvexClient().query(fn, convexArgs(args))) as T;
}

export async function convexMutation<T>(fn: any, args: Record<string, unknown>): Promise<T> {
  return (await requireConvexClient().mutation(fn, convexArgs(args))) as T;
}

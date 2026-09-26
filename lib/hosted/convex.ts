import { ConvexHttpClient } from 'convex/browser';
import type { FunctionArgs, FunctionReference } from 'convex/server';
import type { GenericId } from 'convex/values';
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
      ? {
          // The assertion only matters under Bun's types, where fetch also has preconnect.
          fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
            fetch(input, { ...init, signal })) as typeof fetch,
        }
      : {}),
  });
}

export function requireConvexClient() {
  if (!isConvexConfigured())
    throw new Error('Convex is not configured. Set NEXT_PUBLIC_CONVEX_URL and CONVEX_DEPLOYMENT.');
  if (!client) client = createClient();
  return client;
}

type PublicFunction<Kind extends 'query' | 'mutation'> = FunctionReference<Kind, 'public'>;

// Server code holds Convex ids as plain strings (route params, request bodies).
// The function's own validators check them, so a string is accepted for an id.
type LooseIds<T> =
  T extends GenericId<string>
    ? string
    : T extends readonly (infer Item)[]
      ? LooseIds<Item>[]
      : T extends Record<string, unknown>
        ? { [Key in keyof T]: LooseIds<T[Key]> }
        : T;

type CallerArgs<Fn extends FunctionReference<any, any>> = Omit<FunctionArgs<Fn>, 'internalSecret'>;

/** The arguments a caller passes; convexArgs adds the internal secret. */
export type ConvexCallArgs<Fn extends FunctionReference<any, any>> = {
  [Key in keyof CallerArgs<Fn>]: LooseIds<CallerArgs<Fn>[Key]>;
};

export function convexArgs<T extends Record<string, unknown>>(args: T): T & { internalSecret?: string } {
  const internalSecret = convexInternalSecret();
  return internalSecret ? { ...args, internalSecret } : args;
}

// T is the result type the caller expects. When a call leaves T out, the
// arguments are checked against the function's validators.
export async function convexQuery<T = unknown, Fn extends PublicFunction<'query'> = PublicFunction<'query'>>(
  fn: Fn,
  args: ConvexCallArgs<Fn>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  // A scoped client avoids attaching one user's cancellation to the shared client.
  const scoped = signal ? createClient(signal) : requireConvexClient();
  return (await scoped.query(fn, convexArgs(args as Record<string, unknown>) as FunctionArgs<Fn>)) as T;
}

export async function convexMutation<
  T = unknown,
  Fn extends PublicFunction<'mutation'> = PublicFunction<'mutation'>,
>(fn: Fn, args: ConvexCallArgs<Fn>): Promise<T> {
  return (await requireConvexClient().mutation(
    fn,
    convexArgs(args as Record<string, unknown>) as FunctionArgs<Fn>,
  )) as T;
}

import { NextResponse } from 'next/server';
import { api, convexMutation } from '@/lib/hosted/convex';

export interface UserRateLimitOptions {
  userId: string;
  key: string;
  limit: number;
  windowMs: number;
}

export class RateLimitError extends Error {
  readonly retryAfterMs: number;
  readonly limit: number;

  constructor(message: string, retryAfterMs: number, limit: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
    this.limit = limit;
  }
}

export async function enforceUserRateLimit(options: UserRateLimitOptions) {
  const result = await convexMutation<any>(api.rateLimits.consume, {
    userId: options.userId,
    key: options.key,
    limit: options.limit,
    windowMs: options.windowMs,
  });
  if (!result?.ok) {
    throw new RateLimitError(
      'Too many requests. Try again shortly.',
      result?.retryAfterMs || 1000,
      options.limit,
    );
  }
  return result;
}

// A cheap guard for a small poll that must not cost a Convex mutation of its
// own. It counts per process, so it stops one noisy client, not a distributed one.
const LOCAL_WINDOW_MAX_KEYS = 5_000;
const localWindows = new Map<string, { startedAt: number; count: number }>();

export function enforceLocalRateLimit(options: UserRateLimitOptions, now = Date.now()) {
  const key = `${options.userId}:${options.key}`;
  const current = localWindows.get(key);
  if (!current || now - current.startedAt >= options.windowMs) {
    if (localWindows.size >= LOCAL_WINDOW_MAX_KEYS) localWindows.clear();
    localWindows.set(key, { startedAt: now, count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > options.limit)
    throw new RateLimitError(
      'Too many requests. Try again shortly.',
      current.startedAt + options.windowMs - now,
      options.limit,
    );
}

export function rateLimitJson(err: RateLimitError) {
  const retryAfterSeconds = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
  return NextResponse.json(
    { ok: false, error: err.message, retryAfterSeconds, limit: err.limit },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

export function rateLimitResponse(err: RateLimitError) {
  const retryAfterSeconds = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
  return new Response(
    JSON.stringify({ ok: false, error: err.message, retryAfterSeconds, limit: err.limit }),
    {
      status: 429,
      headers: { 'content-type': 'application/json', 'Retry-After': String(retryAfterSeconds) },
    },
  );
}

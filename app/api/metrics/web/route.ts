import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import {
  MAX_SPEED_VALUE,
  MAX_WEB_METRIC_EVENTS,
  MAX_WEB_METRICS_BYTES,
  WEB_FORM_FACTORS,
  WEB_SPEED_METRICS,
  WEB_SPEED_SURFACES,
} from '@/lib/ops/speed';
import { createBeaconLimiter, createSpeedBuffer } from '@/lib/ops/speed-buffer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The browser sends one batch at most every 30 seconds (lib/ops/surface-timing.ts).
// The body holds names and numbers only. An unknown name or an extra field
// rejects the whole body, so no URL, id, or title can come in.

const bodySchema = z.strictObject({
  formFactor: z.enum(WEB_FORM_FACTORS),
  events: z
    .array(
      z.strictObject({
        metric: z.enum(WEB_SPEED_METRICS),
        surface: z.enum(WEB_SPEED_SURFACES),
        value: z.number().min(0).max(MAX_SPEED_VALUE),
      }),
    )
    .min(1)
    .max(MAX_WEB_METRIC_EVENTS),
});

const defaultBuffer = createSpeedBuffer({
  write: (rows) => convexMutation(api.speedRollups.addWebRollups, { rows }),
  now: () => Date.now(),
  schedule: (run, ms) => {
    // A pending flush must not keep a finished process alive.
    (setTimeout(run, ms) as { unref?: () => void }).unref?.();
  },
  onError: (error) => {
    console.error('[metrics/web] the flush failed:', error instanceof Error ? error.message : 'unknown');
  },
});

const defaultDependencies = {
  user: requireCurrentUser,
  add: defaultBuffer.add,
  allow: createBeaconLimiter({ limit: 12, windowMs: 60_000 }),
  now: () => Date.now(),
};

export function createWebMetricsPost(overrides: Partial<typeof defaultDependencies> = {}) {
  const deps = { ...defaultDependencies, ...overrides };
  return async function POST(req: NextRequest) {
    let userId: string;
    try {
      ({ userId } = await deps.user());
    } catch (error) {
      if (error instanceof AuthRequiredError)
        return NextResponse.json({ ok: false, error: 'Sign in first.' }, { status: 401 });
      throw error;
    }
    if (!(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json'))
      return NextResponse.json({ ok: false, error: 'The body must be JSON.' }, { status: 415 });
    if (Number(req.headers.get('content-length') || 0) > MAX_WEB_METRICS_BYTES)
      return NextResponse.json({ ok: false, error: 'The body is too large.' }, { status: 413 });
    if (!deps.allow(userId, deps.now()))
      return NextResponse.json({ ok: false, error: 'Too many batches.' }, { status: 429 });
    const text = await req.text();
    // A chunked body has no length header, so the real length counts too.
    if (new TextEncoder().encode(text).length > MAX_WEB_METRICS_BYTES)
      return NextResponse.json({ ok: false, error: 'The body is too large.' }, { status: 413 });
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return NextResponse.json({ ok: false, error: 'The body must be JSON.' }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success)
      return NextResponse.json({ ok: false, error: 'The body has an unknown field.' }, { status: 400 });
    deps.add(parsed.data.events.map((event) => ({ ...event, formFactor: parsed.data.formFactor })));
    return new NextResponse(null, { status: 204 });
  };
}

export const POST = createWebMetricsPost();

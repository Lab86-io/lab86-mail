import type { NextRequest } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    await requireCurrentUser();
    const body = await req.json();
    const endpoint = String(body.endpoint || '');
    const p256dh = String(body.keys?.p256dh || '');
    const auth = String(body.keys?.auth || '');
    if (!endpoint || !p256dh || !auth) {
      return Response.json({ ok: false, error: 'complete push subscription required' }, { status: 400 });
    }
    const subscriptionId = await convexMutation((api as any).albatrossNotifications.upsertPushSubscription, {
      endpoint,
      p256dh,
      auth,
      userAgent: req.headers.get('user-agent') || undefined,
    });
    return Response.json({ ok: true, subscriptionId });
  } catch (error) {
    const status = error instanceof AuthRequiredError ? 401 : 500;
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'push failed' },
      { status },
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requireCurrentUser();
    const body = await req.json();
    const endpoint = String(body.endpoint || '');
    if (endpoint) {
      await convexMutation((api as any).albatrossNotifications.revokePushSubscription, { endpoint });
    }
    return Response.json({ ok: true });
  } catch (error) {
    const status = error instanceof AuthRequiredError ? 401 : 500;
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'push failed' },
      { status },
    );
  }
}

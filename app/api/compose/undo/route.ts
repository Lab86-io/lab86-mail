import { NextRequest, NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { stopNylasScheduledMessage } from '@/lib/nylas/provider';
import { cancelPending, parseProviderPendingId, rememberPendingStatus } from '@/lib/send/pending';
import { writeAudit } from '@/lib/store/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  const pendingId = String(body?.pendingId || '');
  if (!pendingId) return NextResponse.json({ ok: false, error: 'pendingId is required' }, { status: 400 });

  try {
    const user = await requireCurrentUser();
    // Pending ids are minted as `${userId}:${uuid}` — only the owner cancels.
    if (!pendingId.startsWith(`${user.userId}:`)) {
      return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    }
    const providerPending = parseProviderPendingId(pendingId, user.userId);
    let undone = false;
    if (providerPending) {
      try {
        const result = await stopNylasScheduledMessage({
          userId: user.userId,
          account: providerPending.account,
          scheduleId: providerPending.scheduleId,
        });
        undone = Boolean(result);
        rememberPendingStatus(pendingId, undone ? 'cancelled' : 'failed');
      } catch (err) {
        rememberPendingStatus(pendingId, 'failed', err);
        undone = false;
      }
    } else {
      undone = cancelPending(pendingId);
    }
    await writeAudit({
      tool: 'compose_route:undo',
      userId: user.userId,
      account: providerPending?.account || null,
      args: { pendingId },
      result: undone ? 'ok' : 'error',
      detail: undone ? undefined : 'window already elapsed',
      agent: 'user',
    }).catch(() => undefined);
    return NextResponse.json({ ok: true, undone });
  } catch (err: any) {
    const status = err instanceof AuthRequiredError ? 401 : 500;
    return NextResponse.json({ ok: false, error: err?.message || 'undo failed' }, { status });
  }
}

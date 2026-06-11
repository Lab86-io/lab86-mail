import { NextRequest, NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { getNylasScheduledSendStatus } from '@/lib/nylas/provider';
import { getPendingStatus, parseProviderPendingId, rememberPendingStatus } from '@/lib/send/pending';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const pendingId = req.nextUrl.searchParams.get('pendingId') || '';
  if (!pendingId) return NextResponse.json({ ok: false, error: 'pendingId is required' }, { status: 400 });

  try {
    const user = await requireCurrentUser();
    if (!pendingId.startsWith(`${user.userId}:`)) {
      return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    }
    const local = getPendingStatus(pendingId);
    // Provider-side scheduled sends (the undo-window path) execute on Nylas,
    // so the app never observes the send locally — after the window, ask the
    // provider for the schedule's real status instead of reporting 'unknown'
    // forever (which suppressed the sent confirmation + confetti).
    const provider = parseProviderPendingId(pendingId, user.userId);
    if (provider && (local.status === 'unknown' || local.status === 'pending')) {
      if (Date.now() >= provider.fireAt) {
        const remote = await getNylasScheduledSendStatus({
          userId: user.userId,
          account: provider.account,
          scheduleId: provider.scheduleId,
        }).catch(() => null);
        if (remote && remote !== 'pending') {
          rememberPendingStatus(pendingId, remote);
          return NextResponse.json({ ok: true, status: remote, fireAt: provider.fireAt });
        }
      }
    }
    return NextResponse.json({ ok: true, ...local });
  } catch (err: any) {
    const status = err instanceof AuthRequiredError ? 401 : 500;
    return NextResponse.json({ ok: false, error: err?.message || 'status failed' }, { status });
  }
}

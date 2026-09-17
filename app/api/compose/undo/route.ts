import { NextRequest, NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { stopNylasScheduledMessage } from '@/lib/nylas/provider';
import {
  cancelPending,
  getPendingStatus,
  parseProviderPendingId,
  rememberPendingStatus,
} from '@/lib/send/pending';
import { writeAudit } from '@/lib/store/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultDependencies = { requireCurrentUser, stopNylasScheduledMessage, writeAudit };

export function createComposeUndoPost(deps = defaultDependencies) {
  return async function POST(req: NextRequest) {
    let body: any = {};
    try {
      body = await req.json();
    } catch {}
    const pendingId = String(body?.pendingId || '');
    if (!pendingId) return NextResponse.json({ ok: false, error: 'pendingId is required' }, { status: 400 });

    try {
      const user = await deps.requireCurrentUser();
      // Pending ids are minted as `${userId}:${uuid}` — only the owner cancels.
      if (!pendingId.startsWith(`${user.userId}:`)) {
        return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
      }
      const providerPending = parseProviderPendingId(pendingId, user.userId);
      let undone = false;
      const current = getPendingStatus(pendingId);
      if (current.status === 'cancelled') {
        // Cancellation is idempotent. A second scene or a foreground
        // reconciliation must receive the same successful outcome.
        undone = true;
      } else if (providerPending && Date.now() >= providerPending.fireAt) {
        undone = false;
      } else if (providerPending) {
        try {
          const result = await deps.stopNylasScheduledMessage({
            userId: user.userId,
            account: providerPending.account,
            scheduleId: providerPending.scheduleId,
          });
          undone = Boolean(result);
          if (undone) rememberPendingStatus(pendingId, 'cancelled');
        } catch {
          // Cancellation failure says nothing about delivery. Keep polling the
          // provider; marking the SEND failed could invite a duplicate resend.
          undone = false;
        }
      } else {
        undone = cancelPending(pendingId);
        if (!undone && getPendingStatus(pendingId).status === 'cancelled') undone = true;
      }
      await deps
        .writeAudit({
          tool: 'compose_route:undo',
          userId: user.userId,
          account: providerPending?.account || null,
          args: { pendingId },
          result: undone ? 'ok' : 'error',
          detail: undone ? undefined : 'window already elapsed',
          agent: 'user',
        })
        .catch(() => undefined);
      return NextResponse.json({ ok: true, undone });
    } catch (err: any) {
      const status = err instanceof AuthRequiredError ? 401 : 500;
      return NextResponse.json({ ok: false, error: err?.message || 'undo failed' }, { status });
    }
  };
}

export const POST = createComposeUndoPost();

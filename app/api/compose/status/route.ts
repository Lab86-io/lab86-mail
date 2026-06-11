import { NextRequest, NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { getPendingStatus } from '@/lib/send/pending';

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
    return NextResponse.json({ ok: true, ...getPendingStatus(pendingId) });
  } catch (err: any) {
    const status = err instanceof AuthRequiredError ? 401 : 500;
    return NextResponse.json({ ok: false, error: err?.message || 'status failed' }, { status });
  }
}

import { NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { officeFailure } from '@/lib/documents/office-http';
import { getOfficeFile, requireOffice, startOfficeSession } from '@/lib/documents/office-service';
import { enforceUserRateLimit } from '@/lib/rate-limit';
export const runtime = 'nodejs';
export async function POST(_request: Request, context: { params: Promise<{ documentId: string }> }) {
  try {
    const user = await requireCurrentUser();
    requireOffice();
    await enforceUserRateLimit({ userId: user.userId, key: 'office-session', limit: 20, windowMs: 60_000 });
    const { documentId } = await context.params;
    const file = await getOfficeFile(user.userId, documentId);
    if (!file) return NextResponse.json({ ok: false, error: 'File not found.' }, { status: 404 });
    return NextResponse.json(
      { ok: true, ...(await startOfficeSession(user.userId, file)) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return officeFailure(error);
  }
}

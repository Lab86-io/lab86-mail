import { NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { officeFailure } from '@/lib/documents/office-http';
import { getOfficeFile, publicOfficeFile } from '@/lib/documents/office-service';
import { enforceUserRateLimit } from '@/lib/rate-limit';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, context: { params: Promise<{ documentId: string }> }) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({ userId: user.userId, key: 'office-read', limit: 120, windowMs: 60_000 });
    const { documentId } = await context.params;
    const file = await getOfficeFile(user.userId, documentId);
    if (!file) return NextResponse.json({ ok: false, error: 'File not found.' }, { status: 404 });
    const { version: _version, ...document } = publicOfficeFile(file);
    return NextResponse.json({ ok: true, document });
  } catch (error) {
    return officeFailure(error);
  }
}

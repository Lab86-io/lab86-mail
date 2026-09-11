import { z } from 'zod';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { openGoogleOfficeFile } from '@/lib/documents/google-office';
import { officeFailure } from '@/lib/documents/office-http';
import { requireOffice } from '@/lib/documents/office-service';
import { enforceUserRateLimit } from '@/lib/rate-limit';
export const runtime = 'nodejs';
export const maxDuration = 120;
export async function POST(request: Request) {
  try {
    const user = await requireCurrentUser();
    requireOffice();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'google-office-open',
      limit: 20,
      windowMs: 60_000,
    });
    const input = z
      .object({ connectionId: z.string().min(1).max(500), fileId: z.string().min(1).max(500) })
      .parse(await request.json());
    const result = await openGoogleOfficeFile({ userId: user.userId, ...input });
    return Response.json({ ok: true, documentId: result.documentId }, { status: result.created ? 201 : 200 });
  } catch (error) {
    return officeFailure(error);
  }
}

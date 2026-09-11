import { requireCurrentUser } from '@/lib/auth/current-user';
import { saveGoogleOfficeFile } from '@/lib/documents/google-office';
import { officeFailure } from '@/lib/documents/office-http';
import { enforceUserRateLimit } from '@/lib/rate-limit';
export const runtime = 'nodejs';
export const maxDuration = 120;
export async function POST(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'office-google-save',
      limit: 20,
      windowMs: 60_000,
    });
    const { saveId } = await request.json();
    const { documentId } = await params;
    return Response.json(await saveGoogleOfficeFile(user.userId, documentId, saveId));
  } catch (error) {
    return officeFailure(error);
  }
}

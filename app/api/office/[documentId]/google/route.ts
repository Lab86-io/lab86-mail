import { requireCurrentUser } from '@/lib/auth/current-user';
import { saveGoogleWorkingCopy } from '@/lib/documents/google-working-copy';
import { officeFailure } from '@/lib/documents/office-http';
import { OfficeError, readOfficeResponse } from '@/lib/documents/office-security';
import { getOfficeFile } from '@/lib/documents/office-service';
import { api, convexMutation } from '@/lib/hosted/convex';
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
    if (typeof saveId !== 'string' || saveId.length > 80)
      throw new OfficeError('Save the editor copy before updating Google.');
    const { documentId } = await params;
    const file = await getOfficeFile(user.userId, documentId);
    if (!file?.google || !file.version?.url) throw new OfficeError('Google working copy not found.', 404);
    if (file.lastWopiSave?.id !== saveId)
      throw new OfficeError(
        'The editor is still saving. Wait for the upload to finish, then try again.',
        409,
      );
    if (file.google.syncedRevision === file.currentRevision)
      return Response.json({ ok: true, revision: file.currentRevision });
    const response = await fetch(file.version.url, {
      signal: AbortSignal.timeout(45_000),
      redirect: 'error',
    });
    const bytes = await readOfficeResponse(response);
    const result = await saveGoogleWorkingCopy({
      userId: user.userId,
      session: file.google.session,
      bytes,
      extension: file.extension,
    });
    const linked = await convexMutation<{ ok: boolean }>((api as any).officeDocuments.linkGoogle, {
      userId: user.userId,
      documentId,
      expectedSession: file.google.session,
      session: result.session,
      syncedRevision: file.currentRevision,
    });
    if (!linked.ok)
      throw new OfficeError(
        'Google saved this revision, but the working copy changed. Reopen the original before saving again.',
        409,
      );
    return Response.json({ ok: true, revision: file.currentRevision, webUrl: result.webUrl });
  } catch (error) {
    return officeFailure(error);
  }
}

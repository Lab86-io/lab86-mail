import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { downloadGoogleWorkingCopy } from '@/lib/documents/google-working-copy';
import { officeFailure } from '@/lib/documents/office-http';
import { validateOfficeArchive } from '@/lib/documents/office-security';
import {
  createOfficeFile,
  getOfficeFile,
  requireOffice,
  storeOfficeBytes,
} from '@/lib/documents/office-service';
import { api, convexMutation } from '@/lib/hosted/convex';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { decryptSecret } from '@/lib/security/crypto';
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
    const copy = await downloadGoogleWorkingCopy({ userId: user.userId, ...input });
    const { etag } = JSON.parse(decryptSecret(copy.session));
    const documentId = `google-${createHash('sha256')
      .update(JSON.stringify([user.userId, input.connectionId, input.fileId, etag]))
      .digest('hex')
      .slice(0, 40)}`;
    const existing = await getOfficeFile(user.userId, documentId);
    if (existing?.google) {
      await convexMutation((api as any).officeDocuments.linkGoogle, {
        userId: user.userId,
        documentId,
        expectedSession: existing.google.session,
        session: copy.session,
        syncedRevision: existing.google.syncedRevision,
      });
      return Response.json({ ok: true, documentId });
    }
    const sha256 = validateOfficeArchive(copy.bytes, copy.extension);
    const storageId = await storeOfficeBytes(user.userId, copy.bytes, copy.extension);
    await createOfficeFile({
      userId: user.userId,
      documentId,
      title: copy.title,
      extension: copy.extension,
      storageId,
      size: copy.bytes.length,
      sha256,
      google: { ...input, session: copy.session, syncedRevision: 1 },
    });
    return Response.json({ ok: true, documentId }, { status: 201 });
  } catch (error) {
    return officeFailure(error);
  }
}

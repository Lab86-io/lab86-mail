import { z } from 'zod';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { downloadGoogleWorkingCopy, saveGoogleWorkingCopy } from '@/lib/documents/google-working-copy';
import { officeFailure } from '@/lib/documents/office-http';
import {
  OFFICE_MAX_BYTES,
  OFFICE_MIME,
  OfficeError,
  officeExtension,
  readOfficeRequest,
} from '@/lib/documents/office-security';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { sanitizeFilename } from '@/lib/shared/files';
export const runtime = 'nodejs';
export const maxDuration = 120;
const identity = z.object({ connectionId: z.string().min(1).max(500), fileId: z.string().min(1).max(500) });
export async function GET(request: Request) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'google-working-copy',
      limit: 20,
      windowMs: 60_000,
    });
    const input = identity.parse(Object.fromEntries(new URL(request.url).searchParams));
    const copy = await downloadGoogleWorkingCopy({ userId: user.userId, ...input });
    return new Response(new Uint8Array(copy.bytes), {
      headers: {
        'Content-Type': OFFICE_MIME[copy.extension],
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${sanitizeFilename(copy.title)}.${copy.extension}`)}`,
        'X-Albatross-Working-Copy': copy.session,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    return officeFailure(error);
  }
}
export async function PUT(request: Request) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'google-working-copy-save',
      limit: 10,
      windowMs: 60_000,
    });
    const bytes = await readOfficeRequest(request, OFFICE_MAX_BYTES + 100_000);
    const form = await new Response(new Uint8Array(bytes), {
      headers: { 'Content-Type': request.headers.get('content-type') || '' },
    }).formData();
    const file = form.get('file');
    const session = form.get('session');
    if (!(file instanceof File) || typeof session !== 'string')
      throw new OfficeError('Choose your edited working copy first.');
    const result = await saveGoogleWorkingCopy({
      userId: user.userId,
      session,
      bytes: new Uint8Array(await file.arrayBuffer()),
      extension: officeExtension(file.name),
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return officeFailure(error);
  }
}

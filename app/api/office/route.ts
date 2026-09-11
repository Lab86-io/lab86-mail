import { NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { officeFailure } from '@/lib/documents/office-http';
import {
  OFFICE_MAX_BYTES,
  OfficeError,
  officeConfiguration,
  officeExtension,
  readOfficeRequest,
  validateOfficeArchive,
} from '@/lib/documents/office-security';
import {
  createOfficeFile,
  listOfficeFiles,
  publicOfficeFile,
  requireOffice,
  storeOfficeBytes,
} from '@/lib/documents/office-service';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { sanitizeFilename } from '@/lib/shared/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireCurrentUser();
    const enabled = Boolean(officeConfiguration());
    await enforceUserRateLimit({ userId: user.userId, key: 'office-list', limit: 120, windowMs: 60_000 });
    const files = (await listOfficeFiles(user.userId)).map(publicOfficeFile);
    return NextResponse.json({ ok: true, enabled, files });
  } catch (error) {
    return officeFailure(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireCurrentUser();
    requireOffice();
    await enforceUserRateLimit({ userId: user.userId, key: 'office-import', limit: 10, windowMs: 60_000 });
    const body = await readOfficeRequest(request, OFFICE_MAX_BYTES + 100_000);
    const form = await new Response(new Uint8Array(body), {
      headers: { 'Content-Type': request.headers.get('content-type') || '' },
    }).formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new OfficeError('Choose an Office file to create a working copy.');
    if (file.size > OFFICE_MAX_BYTES) throw new OfficeError('Office files must be 25 MB or smaller.', 413);
    const title = sanitizeFilename(file.name).slice(0, 500);
    const extension = officeExtension(title);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = validateOfficeArchive(bytes, extension);
    const storageId = await storeOfficeBytes(user.userId, bytes, extension);
    const document = await createOfficeFile({
      userId: user.userId,
      title,
      extension,
      storageId,
      size: bytes.length,
      sha256,
    });
    return NextResponse.json({ ok: true, document }, { status: 201 });
  } catch (error) {
    return officeFailure(error);
  }
}

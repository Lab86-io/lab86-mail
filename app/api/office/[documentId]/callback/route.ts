import { NextResponse } from 'next/server';
import { officeCapability } from '@/lib/documents/office-http';
import {
  OfficeError,
  readOfficeRequest,
  readOfficeResponse,
  validateOfficeArchive,
  validateOfficeDownloadUrl,
  verifyOfficeToken,
} from '@/lib/documents/office-security';
import {
  getOfficeFile,
  getOfficeSession,
  requireOffice,
  saveOfficeVersion,
  storeOfficeBytes,
} from '@/lib/documents/office-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ documentId: string }> }) {
  try {
    // Finish previously authorized saves when new editor sessions are disabled.
    const configuration = requireOffice(true);
    const { documentId } = await context.params;
    const capability = officeCapability(request, configuration.secret, documentId, 'callback');
    const raw = await readOfficeRequest(request, 100_000);
    const body = JSON.parse(raw.toString('utf8')) as { token?: string };
    const token = body.token || request.headers.get('authorization')?.replace(/^Bearer /iu, '') || '';
    const signed = verifyOfficeToken(token, configuration.secret);
    // JWT may wrap the callback under payload when sent in the Authorization header.
    const payload = (signed.payload ?? signed) as Record<string, unknown>;
    const session = await getOfficeSession(capability.userId, documentId, capability.sessionId);
    if (!session || payload.key !== session.key)
      throw new OfficeError('Callback does not match this editing session.', 401);
    if (payload.status === 1 || payload.status === 4) return NextResponse.json({ error: 0 });
    if (payload.status !== 2 && payload.status !== 6)
      throw new OfficeError('The document server reported an unsuccessful save.', 409);
    const document = await getOfficeFile(capability.userId, documentId);
    if (!document) throw new OfficeError('File not found.', 404);
    if (payload.filetype !== undefined && payload.filetype !== document.extension)
      throw new OfficeError('Document server changed the file format.', 409);
    if (typeof payload.url !== 'string') throw new OfficeError('Callback has no signed file URL.');
    const url = validateOfficeDownloadUrl(payload.url, configuration.server);
    const response = await fetch(url, { signal: AbortSignal.timeout(45_000), redirect: 'error' });
    const bytes = await readOfficeResponse(response);
    const sha256 = validateOfficeArchive(bytes, document.extension);
    const storageId = await storeOfficeBytes(capability.userId, bytes, document.extension);
    const result = await saveOfficeVersion({
      userId: capability.userId,
      documentId,
      sessionId: capability.sessionId,
      key: session.key,
      expectedRevision: document.currentRevision,
      storageId,
      size: bytes.length,
      sha256,
    });
    if (!result.ok)
      return NextResponse.json({
        error: 1,
        message:
          result.code === 'REVISION_CONFLICT'
            ? 'Newer edits exist. This save was retained as a recovery version.'
            : 'The save could not be confirmed.',
      });
    return NextResponse.json({ error: 0 });
  } catch (error) {
    // Acknowledging an error as success makes the editor discard its recovery copy.
    return NextResponse.json(
      {
        error: 1,
        message:
          error instanceof OfficeError
            ? error.message
            : 'The save could not be confirmed. Retain the editor recovery copy.',
      },
      { status: error instanceof OfficeError && error.status === 401 ? 401 : 200 },
    );
  }
}

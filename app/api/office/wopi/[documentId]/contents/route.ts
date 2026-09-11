import { wopiContext } from '@/lib/documents/collabora';
import { officeFailure } from '@/lib/documents/office-http';
import {
  OFFICE_MAX_BYTES,
  OFFICE_MIME,
  readOfficeRequest,
  readOfficeResponse,
  validateOfficeArchive,
} from '@/lib/documents/office-security';
import { getOfficeFile, saveOfficeVersion, storeOfficeBytes } from '@/lib/documents/office-service';
export const runtime = 'nodejs';
export const maxDuration = 120;
type Context = { params: Promise<{ documentId: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const { documentId } = await context.params;
    const { file } = await wopiContext(request, documentId);
    const response = await fetch(file.version!.url!, {
      signal: AbortSignal.timeout(45_000),
      redirect: 'error',
    });
    const bytes = await readOfficeResponse(response);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': OFFICE_MIME[file.extension],
        'Cache-Control': 'private, no-store',
        'X-WOPI-ItemVersion': String(file.currentRevision),
      },
    });
  } catch (error) {
    return officeFailure(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    const { documentId } = await context.params;
    const { file, session, sessionId, userId } = await wopiContext(request, documentId);
    const lock = request.headers.get('x-wopi-lock') || '';
    const activeLock = file.wopiLock && file.wopiLock.expiresAt > Date.now() ? file.wopiLock.value : '';
    if (!lock || activeLock !== lock)
      return new Response(null, { status: 409, headers: { 'X-WOPI-Lock': activeLock } });
    const requestId = request.headers.get('x-cool-wopi-extendeddata') || '';
    const saveRequestId = /^[a-zA-Z0-9-]{1,80}$/.test(requestId) ? requestId : undefined;
    const expectedRevision = file.currentRevision;
    const bytes = await readOfficeRequest(request, OFFICE_MAX_BYTES);
    const sha256 = validateOfficeArchive(bytes, file.extension);
    const storageId = await storeOfficeBytes(userId, bytes, file.extension);
    const saved = await saveOfficeVersion({
      userId,
      documentId,
      sessionId,
      key: session.key,
      expectedRevision,
      storageId,
      size: bytes.length,
      sha256,
      wopiLock: lock,
      saveRequestId,
    });
    if (!saved.ok) {
      const current = await getOfficeFile(userId, documentId);
      return Response.json(
        { ok: false, error: 'The working copy changed. This save could not replace it.' },
        {
          status: 409,
          headers: {
            'X-WOPI-Lock':
              current?.wopiLock && current.wopiLock.expiresAt > Date.now() ? current.wopiLock.value : '',
          },
        },
      );
    }
    return Response.json(
      { LastModifiedTime: new Date(saved.updatedAt).toISOString() },
      { headers: { 'X-WOPI-ItemVersion': String(saved.revision) } },
    );
  } catch (error) {
    return officeFailure(error);
  }
}

import { wopiContext } from '@/lib/documents/collabora';
import { officeFailure } from '@/lib/documents/office-http';
import { api, convexMutation } from '@/lib/hosted/convex';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ documentId: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const { documentId } = await context.params;
    const { config, file, userId } = await wopiContext(request, documentId);
    return Response.json(
      {
        BaseFileName: file.title.endsWith(`.${file.extension}`)
          ? file.title
          : `${file.title}.${file.extension}`,
        OwnerId: userId,
        UserId: userId,
        UserFriendlyName: 'You',
        Size: file.version!.size,
        Version: String(file.currentRevision),
        UserCanWrite: true,
        SupportsUpdate: true,
        SupportsLocks: true,
        SupportsGetLock: true,
        SupportsRename: false,
        UserCanNotWriteRelative: true,
        PostMessageOrigin: config.app,
        EnableOwnerTermination: false,
        DisableExport: false,
        DisableCopy: false,
        LastModifiedTime: new Date(file.updatedAt).toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return officeFailure(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    const { documentId } = await context.params;
    const { userId, sessionId } = await wopiContext(request, documentId);
    const operation = request.headers.get('x-wopi-override');
    if (!['LOCK', 'REFRESH_LOCK', 'UNLOCK', 'GET_LOCK'].includes(operation || ''))
      return new Response(null, { status: 501 });
    const value = request.headers.get('x-wopi-lock') || '';
    if ((operation !== 'GET_LOCK' && !value) || value.length > 1024)
      return new Response(null, { status: 400 });
    const result = await convexMutation<{ ok: boolean; value: string }>(
      (api as any).officeDocuments.wopiLock,
      {
        userId,
        documentId,
        sessionId,
        operation,
        value,
        oldValue: request.headers.get('x-wopi-oldlock') || undefined,
      },
    );
    return new Response(null, { status: result.ok ? 200 : 409, headers: { 'X-WOPI-Lock': result.value } });
  } catch (error) {
    return officeFailure(error);
  }
}

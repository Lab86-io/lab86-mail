import { NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { officeCapability, officeFailure } from '@/lib/documents/office-http';
import { OFFICE_MIME, OfficeError, readOfficeResponse } from '@/lib/documents/office-security';
import { getOfficeFile, getOfficeSession, requireOffice } from '@/lib/documents/office-service';
import { enforceUserRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ documentId: string }> }) {
  try {
    const { documentId } = await context.params;
    const params = new URL(request.url).searchParams;
    let userId: string;
    let revision: number | undefined;
    if (params.has('token')) {
      const configuration = requireOffice(true);
      const capability = officeCapability(request, configuration.secret, documentId, 'download');
      const session = await getOfficeSession(capability.userId, documentId, capability.sessionId);
      if (!session || session.baseRevision !== capability.revision)
        throw new OfficeError('Office session expired.', 401);
      userId = capability.userId;
      revision = capability.revision;
    } else {
      userId = (await requireCurrentUser()).userId;
      await enforceUserRateLimit({ userId, key: 'office-download', limit: 60, windowMs: 60_000 });
      if (params.has('revision')) {
        revision = Number(params.get('revision'));
        if (!Number.isInteger(revision) || revision < 1) throw new OfficeError('Invalid file revision.');
      }
    }
    const file = await getOfficeFile(userId, documentId, revision);
    if (!file?.version?.url) throw new OfficeError('File version not found.', 404);
    // This URL is resolved only from owned Convex storage, never supplied by a caller.
    const response = await fetch(file.version.url, {
      signal: AbortSignal.timeout(45_000),
      redirect: 'error',
    });
    const bytes = await readOfficeResponse(response);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': OFFICE_MIME[file.extension],
        'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.title)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch (error) {
    return officeFailure(error);
  }
}

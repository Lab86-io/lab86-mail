import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { getDocument, listDocumentRevisions, restoreDocumentRevision } from '@/lib/documents/service';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ documentId: string }> };
const restoreSchema = z.object({
  revision: z.number().int().positive(),
  expectedRevision: z.number().int().positive(),
});

function failure(error: unknown) {
  if (error instanceof AuthRequiredError)
    return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
  if (error instanceof RateLimitError) return rateLimitJson(error);
  if (error instanceof z.ZodError)
    return NextResponse.json({ ok: false, error: 'Invalid revision.' }, { status: 400 });
  console.error('[document-revisions]', error);
  return NextResponse.json({ ok: false, error: 'Could not load or restore versions.' }, { status: 500 });
}

export async function GET(_request: Request, context: Context) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({ userId: user.userId, key: 'document-history', limit: 60, windowMs: 60_000 });
    const { documentId } = await context.params;
    if (!(await getDocument(user.userId, documentId)))
      return NextResponse.json({ ok: false, error: 'File not found.' }, { status: 404 });
    const revisions = await listDocumentRevisions(user.userId, documentId);
    return NextResponse.json({
      ok: true,
      revisions: revisions.map(({ model: _model, ...revision }) => revision),
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({ userId: user.userId, key: 'document-restore', limit: 20, windowMs: 60_000 });
    const { documentId } = await context.params;
    const input = restoreSchema.parse(await request.json());
    const result = await restoreDocumentRevision({ userId: user.userId, documentId, ...input });
    if (!result.ok)
      return NextResponse.json(
        {
          ok: false,
          error:
            result.code === 'REVISION_CONFLICT'
              ? 'The file changed. Refresh versions before restoring.'
              : 'Version not found.',
        },
        { status: result.code === 'REVISION_CONFLICT' ? 409 : 404 },
      );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}

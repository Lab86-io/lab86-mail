import type { NextRequest } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { getDocumentImportSource } from '@/lib/documents/service';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { documentContentDisposition } from '../export/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** Streams the untouched bytes a workbook was imported from. Never the engine's rendering. */
export async function GET(_req: NextRequest, context: { params: Promise<{ documentId: string }> }) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'document-original',
      limit: 30,
      windowMs: 60_000,
    });
    const { documentId } = await context.params;
    const source = await getDocumentImportSource(user.userId, documentId);
    if (!source)
      return Response.json(
        { ok: false, error: 'No original file is kept for this document.' },
        { status: 404 },
      );
    const upstream = await fetch(source.url, { cache: 'no-store' });
    if (!upstream.ok || !upstream.body) {
      return Response.json({ ok: false, error: 'The original file is unavailable.' }, { status: 502 });
    }
    return new Response(upstream.body, {
      headers: {
        'content-type': source.mimeType,
        'content-length': String(source.size),
        'content-disposition': documentContentDisposition(source.filename),
        'cache-control': 'private, no-store',
        'x-albatross-original-sha256': source.sha256,
      },
    });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitJson(error);
    if (error instanceof AuthRequiredError) {
      return Response.json({ ok: false, error: error.message }, { status: 401 });
    }
    console.error('[document-original]', error);
    return Response.json({ ok: false, error: 'Original download failed.' }, { status: 500 });
  }
}

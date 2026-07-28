import type { NextRequest } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { exportDocument } from '@/lib/documents/export';
import { getDocument } from '@/lib/documents/service';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { sanitizeFilename } from '@/lib/shared/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export function documentContentDisposition(filename: string) {
  const extensionMatch = /(\.[a-z0-9]+)$/iu.exec(filename);
  const extension = extensionMatch?.[1] || '';
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  const asciiStem =
    stem
      .normalize('NFKD')
      .replace(/[^\x20-\x7E]/gu, '')
      .replace(/["\\]/gu, '_')
      .trim() || 'document';
  const ascii = `${asciiStem}${extension}`;
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function GET(_req: NextRequest, context: { params: Promise<{ documentId: string }> }) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'document-export',
      limit: 30,
      windowMs: 60_000,
    });
    const { documentId } = await context.params;
    const document = await getDocument(user.userId, documentId);
    if (!document) return Response.json({ ok: false, error: 'Document not found.' }, { status: 404 });
    const exported = await exportDocument(document);
    const baseName = sanitizeFilename(document.title || 'Untitled').replace(/\.[a-z0-9]+$/iu, '');
    const filename = `${baseName}.${exported.extension}`;
    return new Response(exported.bytes as BodyInit, {
      headers: {
        'content-type': exported.contentType,
        'content-disposition': documentContentDisposition(filename),
        'cache-control': 'private, no-store',
      },
    });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitJson(error);
    if (error instanceof AuthRequiredError) {
      return Response.json({ ok: false, error: error.message }, { status: 401 });
    }
    console.error('[document-export]', error);
    return Response.json({ ok: false, error: 'Export failed.' }, { status: 500 });
  }
}

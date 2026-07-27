import type { NextRequest } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { exportDocument } from '@/lib/documents/export';
import { getDocument } from '@/lib/documents/service';
import { sanitizeFilename } from '@/lib/shared/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(_req: NextRequest, context: { params: Promise<{ documentId: string }> }) {
  try {
    const user = await requireCurrentUser();
    const { documentId } = await context.params;
    const document = await getDocument(user.userId, documentId);
    if (!document) return Response.json({ ok: false, error: 'Document not found.' }, { status: 404 });
    const exported = await exportDocument(document);
    const baseName = sanitizeFilename(document.title || 'Untitled').replace(/\.[a-z0-9]+$/iu, '');
    return new Response(exported.bytes as BodyInit, {
      headers: {
        'content-type': exported.contentType,
        'content-disposition': `attachment; filename="${baseName}.${exported.extension}"`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (error) {
    console.error('[document-export]', error);
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Export failed.' },
      { status: 500 },
    );
  }
}

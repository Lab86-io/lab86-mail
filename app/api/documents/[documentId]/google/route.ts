import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { GoogleDocumentConflictError, publishDocumentToGoogle } from '@/lib/documents/google';
import { getDocument } from '@/lib/documents/service';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const inputSchema = z.object({ connectionId: z.string().min(1).max(500).optional() });

export async function POST(req: NextRequest, context: { params: Promise<{ documentId: string }> }) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'document-google-publish',
      limit: 30,
      windowMs: 60_000,
    });
    const { documentId } = await context.params;
    const input = inputSchema.parse(await req.json().catch(() => ({})));
    const document = await getDocument(user.userId, documentId);
    if (!document) return NextResponse.json({ ok: false, error: 'Document not found.' }, { status: 404 });
    const google = await publishDocumentToGoogle({
      userId: user.userId,
      document,
      connectionId: input.connectionId,
    });
    return NextResponse.json({ ok: true, google });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitJson(error);
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { ok: false, error: error.issues[0]?.message || 'Invalid request.' },
        { status: 400 },
      );
    }
    if (error instanceof GoogleDocumentConflictError) {
      return NextResponse.json(
        { ok: false, error: error.message, code: 'GOOGLE_VERSION_CONFLICT' },
        { status: 409 },
      );
    }
    console.error('[document-google]', error);
    return NextResponse.json({ ok: false, error: 'Google publish failed.' }, { status: 502 });
  }
}

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { applyDocumentSuggestion, getDocument, resolveDocumentSuggestion } from '@/lib/documents/service';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const inputSchema = z.object({ decision: z.enum(['apply', 'dismiss']) });

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ documentId: string; suggestionId: string }> },
) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'document-suggestion-decision',
      limit: 60,
      windowMs: 60_000,
    });
    const { documentId, suggestionId } = await context.params;
    const input = inputSchema.parse(await req.json().catch(() => ({})));
    const document = await getDocument(user.userId, documentId);
    if (!document) return NextResponse.json({ ok: false, error: 'Document not found.' }, { status: 404 });
    const suggestion = document.suggestions.find((candidate) => candidate.suggestionId === suggestionId);
    if (!suggestion) return NextResponse.json({ ok: false, error: 'Suggestion not found.' }, { status: 404 });
    if (input.decision === 'dismiss') {
      const result = await resolveDocumentSuggestion({
        userId: user.userId,
        documentId,
        suggestionId,
        status: 'dismissed',
      });
      if (!result.ok) {
        return NextResponse.json(
          { ok: false, error: 'This suggestion was already resolved.' },
          { status: 409 },
        );
      }
      return NextResponse.json({ ok: true, dismissed: true });
    }
    const result = await applyDocumentSuggestion({
      userId: user.userId,
      documentId,
      suggestionId,
      expectedRevision: document.currentRevision,
    });
    if (!result.ok) {
      const alreadyResolved = result.code === 'ALREADY_RESOLVED';
      return NextResponse.json(
        {
          ok: false,
          error: alreadyResolved
            ? 'This suggestion was already resolved.'
            : 'The document changed before this suggestion could be applied.',
          code: result.code,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, applied: true, document: result.document });
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
    console.error('[document-suggestion]', error);
    return NextResponse.json({ ok: false, error: 'Suggestion operation failed.' }, { status: 500 });
  }
}

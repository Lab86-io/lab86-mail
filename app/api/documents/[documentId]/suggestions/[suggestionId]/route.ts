import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { getDocument, resolveDocumentSuggestion, updateDocument } from '@/lib/documents/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const inputSchema = z.object({ decision: z.enum(['apply', 'dismiss']) });

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ documentId: string; suggestionId: string }> },
) {
  try {
    const user = await requireCurrentUser();
    const { documentId, suggestionId } = await context.params;
    const input = inputSchema.parse(await req.json());
    const document = await getDocument(user.userId, documentId);
    if (!document) return NextResponse.json({ ok: false, error: 'Document not found.' }, { status: 404 });
    const suggestion = document.suggestions.find((candidate) => candidate.suggestionId === suggestionId);
    if (!suggestion) return NextResponse.json({ ok: false, error: 'Suggestion not found.' }, { status: 404 });
    if (input.decision === 'dismiss') {
      await resolveDocumentSuggestion({
        userId: user.userId,
        documentId,
        suggestionId,
        status: 'dismissed',
      });
      return NextResponse.json({ ok: true, dismissed: true });
    }
    const result = await updateDocument({
      userId: user.userId,
      documentId,
      expectedRevision: document.currentRevision,
      title: suggestion.title,
      model: suggestion.proposedModel,
      reason: suggestion.description,
      actor: 'ai',
    });
    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: 'The document changed before this suggestion could be applied.',
          code: result.code,
        },
        { status: 409 },
      );
    }
    await resolveDocumentSuggestion({
      userId: user.userId,
      documentId,
      suggestionId,
      status: 'applied',
    });
    return NextResponse.json({ ok: true, applied: true, document: result.document });
  } catch (error) {
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
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Suggestion operation failed.' },
      { status: 500 },
    );
  }
}

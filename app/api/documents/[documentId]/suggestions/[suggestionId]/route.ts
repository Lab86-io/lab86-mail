import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { applyDocumentSuggestion, getDocument, resolveDocumentSuggestion } from '@/lib/documents/service';
import { DocumentTooLargeError, isSheetWorkbookModel } from '@/lib/documents/sheet-workbook';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const inputSchema = z.object({
  decision: z.enum(['apply', 'dismiss']),
  expectedRevision: z.number().int().positive().optional(),
  /** Engine snapshot after applying a change-set suggestion in the editor. */
  model: z.unknown().optional(),
});

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
    if (input.expectedRevision !== undefined && input.expectedRevision !== document.currentRevision) {
      return NextResponse.json(
        { ok: false, error: 'The document changed. Review its latest version before applying changes.' },
        { status: 409 },
      );
    }
    if (suggestion.proposedModel.kind === 'sheet-changes' && !isSheetWorkbookModel(input.model)) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Open the spreadsheet to apply this suggestion; its changes run inside the editor.',
          code: 'NEEDS_EDITOR',
        },
        { status: 409 },
      );
    }
    const result = await applyDocumentSuggestion({
      userId: user.userId,
      documentId,
      suggestionId,
      expectedRevision: document.currentRevision,
      model: isSheetWorkbookModel(input.model) ? input.model : undefined,
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
    if (error instanceof DocumentTooLargeError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 413 });
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

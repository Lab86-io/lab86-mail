import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { generateDocumentProposal } from '@/lib/documents/ai';
import { createDocumentSuggestion, getDocument, updateDocument } from '@/lib/documents/service';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const inputSchema = z.object({
  instruction: z.string().min(1).max(20_000),
  mode: z.enum(['suggest', 'apply']).default('suggest'),
  sourceContext: z.string().max(40_000).optional(),
});

export async function POST(req: NextRequest, context: { params: Promise<{ documentId: string }> }) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'document-ai',
      limit: 20,
      windowMs: 60_000,
    });
    const { documentId } = await context.params;
    const input = inputSchema.parse(await req.json());
    const document = await getDocument(user.userId, documentId);
    if (!document) return NextResponse.json({ ok: false, error: 'Document not found.' }, { status: 404 });
    const proposal = await generateDocumentProposal({
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      kind: document.kind,
      instruction: input.instruction,
      current: document,
      sourceContext: input.sourceContext,
    });
    if (input.mode === 'apply') {
      const result = await updateDocument({
        userId: user.userId,
        documentId,
        expectedRevision: document.currentRevision,
        title: proposal.title,
        model: proposal.model,
        reason: proposal.summary,
        actor: 'ai',
      });
      if (!result.ok) {
        return NextResponse.json(
          { ok: false, error: 'The document changed while Albatross was editing it.', code: result.code },
          { status: 409 },
        );
      }
      return NextResponse.json({
        ok: true,
        applied: true,
        summary: proposal.summary,
        document: result.document,
      });
    }
    const suggestion = await createDocumentSuggestion({
      userId: user.userId,
      documentId,
      title: proposal.title,
      description: proposal.summary,
      proposedModel: proposal.model,
      sourceRefs: document.sourceRefs,
    });
    return NextResponse.json({
      ok: true,
      applied: false,
      suggestion: {
        suggestionId: suggestion.suggestionId,
        documentId,
        title: proposal.title,
        description: proposal.summary,
        proposedModel: proposal.model,
        sourceRefs: document.sourceRefs,
        status: 'proposed',
        createdAt: suggestion.createdAt || Date.now(),
      },
    });
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
    console.error('[document-ai]', error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Albatross could not edit this document.',
      },
      { status: 500 },
    );
  }
}

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { DocumentGenerationError, generateDocumentProposal } from '@/lib/documents/ai';
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

interface DocumentAiDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  getDocument: typeof getDocument;
  generateDocumentProposal: typeof generateDocumentProposal;
  updateDocument: typeof updateDocument;
  createDocumentSuggestion: typeof createDocumentSuggestion;
  reportUnexpectedError: (label: string, error: unknown) => void;
}

const defaultDependencies: DocumentAiDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  getDocument,
  generateDocumentProposal,
  updateDocument,
  createDocumentSuggestion,
  reportUnexpectedError: (label, error) => console.error(label, error),
};

export function createDocumentAiPost(deps: DocumentAiDependencies = defaultDependencies) {
  return async function documentAiPost(
    req: NextRequest,
    context: { params: Promise<{ documentId: string }> },
  ) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'document-ai',
        limit: 20,
        windowMs: 60_000,
      });
      const { documentId } = await context.params;
      const input = inputSchema.parse(await req.json().catch(() => ({})));
      const document = await deps.getDocument(user.userId, documentId);
      if (!document) return NextResponse.json({ ok: false, error: 'Document not found.' }, { status: 404 });
      const proposal = await deps.generateDocumentProposal({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        kind: document.kind,
        instruction: input.instruction,
        current: document,
        sourceContext: input.sourceContext,
      });
      if (input.mode === 'apply') {
        const result = await deps.updateDocument({
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
      const suggestion = await deps.createDocumentSuggestion({
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
      if (error instanceof DocumentGenerationError) {
        deps.reportUnexpectedError('[document-ai] Invalid model output:', error);
        return NextResponse.json(
          { ok: false, error: 'Albatross returned an invalid document edit. Try again.' },
          { status: 502 },
        );
      }
      deps.reportUnexpectedError('[document-ai]', error);
      return NextResponse.json(
        { ok: false, error: 'Albatross could not edit this document.' },
        { status: 500 },
      );
    }
  };
}

export const POST = createDocumentAiPost();

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { DocumentGenerationError, generateDocumentProposal } from '@/lib/documents/ai';
import {
  createDefaultDocumentModel,
  DOCUMENT_KINDS,
  documentKindLabel,
  parseDocumentModel,
} from '@/lib/documents/model';
import { createDocument, listDocuments } from '@/lib/documents/service';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const sourceRefSchema = z.object({
  kind: z.string().min(1).max(80),
  id: z.string().min(1).max(500),
  label: z.string().max(500).optional(),
  accountId: z.string().max(500).optional(),
  url: z.string().max(2_000).optional(),
});

const createSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  title: z.string().max(500).optional(),
  model: z.unknown().optional(),
  instructions: z.string().max(20_000).optional(),
  sourceContext: z.string().max(40_000).optional(),
  sourceRefs: z.array(sourceRefSchema).max(100).default([]),
});

function documentError(error: unknown) {
  if (error instanceof RateLimitError) return rateLimitJson(error);
  if (error instanceof AuthRequiredError) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { ok: false, error: error.issues[0]?.message || 'Invalid document.' },
      { status: 400 },
    );
  }
  if (error instanceof DocumentGenerationError) {
    console.error('[documents] Invalid model output:', error);
    return NextResponse.json(
      { ok: false, error: 'Albatross returned an invalid document. Try again.' },
      { status: 502 },
    );
  }
  console.error('[documents]', error);
  return NextResponse.json({ ok: false, error: 'Document operation failed.' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'document-list',
      limit: 60,
      windowMs: 60_000,
    });
    const rawKind = req.nextUrl.searchParams.get('kind');
    const kind = rawKind && DOCUMENT_KINDS.includes(rawKind as any) ? (rawKind as any) : undefined;
    const rawLimit = req.nextUrl.searchParams.get('limit');
    if (rawLimit !== null && !/^\d+$/u.test(rawLimit)) {
      return NextResponse.json({ ok: false, error: 'limit must be a whole number.' }, { status: 400 });
    }
    const requestedLimit = rawLimit === null ? 200 : Number(rawLimit);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 200;
    const documents = await listDocuments({ userId: user.userId, kind, limit });
    return NextResponse.json({ ok: true, documents });
  } catch (error) {
    return documentError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'document-create',
      limit: 30,
      windowMs: 60_000,
    });
    const input = createSchema.parse(await req.json().catch(() => ({})));
    let title = input.title?.trim() || `Untitled ${documentKindLabel(input.kind)}`;
    let model = input.model
      ? parseDocumentModel(input.model, input.kind)
      : createDefaultDocumentModel(input.kind);
    if (input.instructions?.trim()) {
      const proposal = await generateDocumentProposal({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        kind: input.kind,
        instruction: input.instructions,
        sourceContext: input.sourceContext,
      });
      model = proposal.model;
      if (!input.title?.trim()) title = proposal.title;
    }
    const document = await createDocument({
      userId: user.userId,
      kind: input.kind,
      title,
      model,
      sourceRefs: input.sourceRefs,
      reason: input.instructions?.trim() ? 'ai_create' : 'create',
    });
    return NextResponse.json({ ok: true, document }, { status: 201 });
  } catch (error) {
    return documentError(error);
  }
}

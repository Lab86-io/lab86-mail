import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { archiveDocument, getDocument, updateDocument } from '@/lib/documents/service';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  expectedRevision: z.number().int().positive(),
  title: z.string().max(500).optional(),
  model: z.unknown().optional(),
  reason: z.string().max(200).optional(),
});

function responseForError(error: unknown) {
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
  console.error('[document]', error);
  return NextResponse.json(
    { ok: false, error: error instanceof Error ? error.message : 'Document operation failed.' },
    { status: 500 },
  );
}

export async function GET(_req: NextRequest, context: { params: Promise<{ documentId: string }> }) {
  try {
    const user = await requireCurrentUser();
    const { documentId } = await context.params;
    const document = await getDocument(user.userId, documentId);
    if (!document) return NextResponse.json({ ok: false, error: 'Document not found.' }, { status: 404 });
    return NextResponse.json({ ok: true, document });
  } catch (error) {
    return responseForError(error);
  }
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ documentId: string }> }) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'document-save',
      limit: 120,
      windowMs: 60_000,
    });
    const { documentId } = await context.params;
    const input = patchSchema.parse(await req.json());
    const result = await updateDocument({
      userId: user.userId,
      documentId,
      ...input,
      actor: 'user',
    });
    if (!result.ok && result.code === 'NOT_FOUND') {
      return NextResponse.json({ ok: false, error: 'Document not found.' }, { status: 404 });
    }
    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: 'This document changed somewhere else. Reload before saving.',
          code: result.code,
          document: result.document,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    return responseForError(error);
  }
}

export async function DELETE(_req: NextRequest, context: { params: Promise<{ documentId: string }> }) {
  try {
    const user = await requireCurrentUser();
    const { documentId } = await context.params;
    const result = await archiveDocument(user.userId, documentId);
    if (!result.ok) return NextResponse.json({ ok: false, error: 'Document not found.' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return responseForError(error);
  }
}

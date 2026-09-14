import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { officeFailure } from '@/lib/documents/office-http';
import { readOfficeRequest } from '@/lib/documents/office-security';
import { wordEditsSchema } from '@/lib/documents/word-package';
import { wordDocuments } from '@/lib/documents/word-service';
import { enforceUserRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const inputSchema = z
  .object({
    title: z.string().max(500).default('Untitled document'),
    sourceDocumentId: z.string().min(1).optional(),
    expectedRevision: z.number().int().min(1).optional(),
    edits: wordEditsSchema.optional(),
  })
  .strict();
const dependencies = { requireCurrentUser, enforceUserRateLimit, create: wordDocuments.create };
export function createWordPost(overrides: Partial<typeof dependencies> = {}) {
  const deps = { ...dependencies, ...overrides };
  return async function POST(request: Request) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'word-create',
        limit: 20,
        windowMs: 60_000,
      });
      const bytes = await readOfficeRequest(request, 2_000_000);
      const input = inputSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      const document = await deps.create(user.userId, input);
      return NextResponse.json({ ok: true, document }, { status: 201 });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return NextResponse.json({ ok: false, error: 'Invalid Word document request.' }, { status: 400 });
      return officeFailure(error);
    }
  };
}
export const POST = createWordPost();

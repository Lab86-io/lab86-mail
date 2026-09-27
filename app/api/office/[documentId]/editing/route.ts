import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { officeFailure } from '@/lib/documents/office-http';
import { OfficeError, readOfficeRequest, verifyOfficeToken } from '@/lib/documents/office-security';
import { requireOffice } from '@/lib/documents/office-service';
import { api, convexMutation } from '@/lib/hosted/convex';
import { enforceUserRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const schema = z
  .object({ requestId: z.string().uuid(), token: z.string().max(10_000), failed: z.boolean().optional() })
  .strict();
const dependencies = { requireCurrentUser, enforceUserRateLimit, requireOffice, convexMutation };
export function createWordEditingPost(overrides: Partial<typeof dependencies> = {}) {
  const deps = { ...dependencies, ...overrides };
  return async function POST(request: Request, context: { params: Promise<{ documentId: string }> }) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'word-editing',
        limit: 120,
        windowMs: 60_000,
      });
      const { documentId } = await context.params;
      const input = schema.parse(
        JSON.parse(new TextDecoder().decode(await readOfficeRequest(request, 16_000))),
      );
      const token = verifyOfficeToken(input.token, deps.requireOffice(true).secret);
      if (
        token.purpose !== 'wopi' ||
        typeof token.exp !== 'number' ||
        token.documentId !== documentId ||
        token.userId !== user.userId ||
        typeof token.sessionId !== 'string'
      )
        throw new OfficeError('Invalid editor session.', 403);
      const result = await deps.convexMutation<{ ok: boolean }>(api.officeDocuments.coordinateEdit, {
        userId: user.userId,
        documentId,
        requestId: input.requestId,
        sessionId: token.sessionId,
        action: input.failed ? 'fail' : 'prepare',
      });
      return NextResponse.json(result, { status: result.ok ? 200 : 409 });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return NextResponse.json({ ok: false, error: 'Invalid editor request.' }, { status: 400 });
      return officeFailure(error);
    }
  };
}
export const POST = createWordEditingPost();

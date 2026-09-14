import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { officeFailure } from '@/lib/documents/office-http';
import { readOfficeRequest } from '@/lib/documents/office-security';
import { getOfficeFile, publicOfficeFile } from '@/lib/documents/office-service';
import { api, convexMutation } from '@/lib/hosted/convex';
import { enforceUserRateLimit } from '@/lib/rate-limit';
export const dynamic = 'force-dynamic';
export async function PATCH(request: Request, context: { params: Promise<{ documentId: string }> }) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({ userId: user.userId, key: 'office-rename', limit: 30, windowMs: 60_000 });
    const { documentId } = await context.params;
    const input = z
      .object({ title: z.string().trim().min(1).max(500) })
      .strict()
      .parse(JSON.parse(new TextDecoder().decode(await readOfficeRequest(request, 4000))));
    const result = await convexMutation<{ ok: boolean }>((api as any).officeDocuments.rename, {
      userId: user.userId,
      documentId,
      title: input.title,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 404 });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return NextResponse.json({ ok: false, error: 'Enter a valid file name.' }, { status: 400 });
    return officeFailure(error);
  }
}
export async function GET(_request: Request, context: { params: Promise<{ documentId: string }> }) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({ userId: user.userId, key: 'office-read', limit: 120, windowMs: 60_000 });
    const { documentId } = await context.params;
    const file = await getOfficeFile(user.userId, documentId);
    if (!file) return NextResponse.json({ ok: false, error: 'File not found.' }, { status: 404 });
    const { version: _version, ...document } = publicOfficeFile(file);
    return NextResponse.json({ ok: true, document });
  } catch (error) {
    return officeFailure(error);
  }
}

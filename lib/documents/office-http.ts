import { NextResponse } from 'next/server';
import { AuthRequiredError } from '@/lib/auth/current-user';
import { RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { OfficeError, verifyOfficeToken } from './office-security';

export function officeFailure(error: unknown) {
  if (error instanceof RateLimitError) return rateLimitJson(error);
  if (error instanceof AuthRequiredError)
    return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
  if (error instanceof OfficeError)
    return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
  console.error('[office] operation failed', error instanceof Error ? error.name : 'unknown');
  return NextResponse.json(
    { ok: false, error: 'Office operation failed. Your saved versions remain available.' },
    { status: 500 },
  );
}
export function officeCapability(
  request: Request,
  secret: string,
  documentId: string,
  purpose: 'download' | 'callback',
) {
  const value = verifyOfficeToken(new URL(request.url).searchParams.get('token') || '', secret);
  if (
    value.purpose !== purpose ||
    value.documentId !== documentId ||
    typeof value.userId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.exp !== 'number' ||
    !Number.isInteger(value.revision) ||
    Number(value.revision) < 1
  )
    throw new OfficeError('Invalid Office capability.', 401);
  return value as { userId: string; documentId: string; sessionId: string; revision: number };
}

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError } from '@/lib/auth/current-user';
import { RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { DocumentGenerationError } from './ai';
import { DocumentTooLargeError } from './sheet-workbook';

/** Keep expected document failures actionable without exposing internal errors. */
export function documentError(error: unknown) {
  if (error instanceof RateLimitError) return rateLimitJson(error);
  if (error instanceof AuthRequiredError) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
  }
  if (error instanceof DocumentTooLargeError) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 413 });
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

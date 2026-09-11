import { expect, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { AuthRequiredError } from '../lib/auth/current-user';
import { DocumentGenerationError } from '../lib/documents/ai';
import { documentError } from '../lib/documents/http';
import { DocumentTooLargeError } from '../lib/documents/sheet-workbook';
import { RateLimitError } from '../lib/rate-limit';

test('document failures retain actionable auth, rate-limit, validation and size status', async () => {
  const auth = documentError(new AuthRequiredError('Sign in to edit.'));
  expect(auth.status).toBe(401);
  expect(await auth.json()).toEqual({ ok: false, error: 'Sign in to edit.' });
  const limited = documentError(new RateLimitError('Try later.', 2001, 5));
  expect(limited.status).toBe(429);
  expect(limited.headers.get('Retry-After')).toBe('3');
  const large = documentError(new DocumentTooLargeError(1_000_000));
  expect(large.status).toBe(413);
  expect((await large.json()).ok).toBe(false);
  const invalid = z.string().safeParse(42);
  if (invalid.success) throw new Error('Expected validation failure');
  expect(documentError(invalid.error).status).toBe(400);
  expect(await documentError(new z.ZodError([])).json()).toEqual({ ok: false, error: 'Invalid document.' });
});

test('model and unknown failures never expose provider errors or credentials to clients', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const generated = documentError(new DocumentGenerationError('private provider request'));
    expect(generated.status).toBe(502);
    expect(await generated.json()).toEqual({
      ok: false,
      error: 'Albatross returned an invalid document. Try again.',
    });
    const unknown = documentError(new Error('private database credentials'));
    expect(unknown.status).toBe(500);
    expect(await unknown.json()).toEqual({ ok: false, error: 'Document operation failed.' });
    expect(log).toHaveBeenCalledTimes(2);
  } finally {
    log.mockRestore();
  }
});

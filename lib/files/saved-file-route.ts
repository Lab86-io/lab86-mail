// GET /api/files/saved/[fileId]: one saved file of the signed-in user
// (docs/albatross-goal-runs.md G5).
//
// A plain file streams from storage. A file with sealed fields (a filled PDF
// that takes saved details from Passwords and IDs) needs the identity check
// first: without a first-factor check in the last 10 minutes, the answer is
// 403 with Clerk's reverification body and `code: 'verify_identity'`. The web
// opens Clerk's check and asks again; the native apps offer "Open on the web".
// After the check, the server fills the values in memory and sends the bytes.
// Nothing is cached.
//
// `?preview=1` shows a PDF, PNG, or JPEG in the browser. Every other answer
// is a download, with nosniff and a sandbox, so a file never runs script on
// the app origin.

import { AuthRequiredError, requireCurrentUser } from '../auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '../rate-limit';
import { identityRecentlyChecked, verifyIdentityResponse } from '../secure/identity';
import { errorAnswerMessage } from '../security/error-answer';
import { sanitizeFilename } from '../shared/files';
import { materializeSavedFile, SealedFileError } from './materialize';
import { getSavedFileRow, SavedFileError } from './saved-files';

const PREVIEW_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);

function safeType(raw: string | null | undefined): string {
  const base = String(raw || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base)
    ? base
    : 'application/octet-stream';
}

/** The answer headers of a saved file. */
export function savedFileHeaders(input: {
  contentType: string | null | undefined;
  name: string;
  preview: boolean;
  size?: number;
}): Record<string, string> {
  const type = safeType(input.contentType);
  const inline = input.preview && PREVIEW_TYPES.has(type);
  const name = sanitizeFilename(input.name || 'file');
  const ascii =
    name
      .normalize('NFKD')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/["\\]/g, '_') || 'file';
  const headers: Record<string, string> = {
    'content-type': type,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  };
  if (input.size) headers['content-length'] = String(input.size);
  // Chromium does not start its PDF viewer in a sandboxed document, so only an
  // inline PDF goes without the sandbox (as in the mail attachment route).
  if (!(inline && type === 'application/pdf'))
    headers['content-security-policy'] =
      "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";
  return headers;
}

export const savedFileRouteDefaults = {
  requireCurrentUser,
  enforceUserRateLimit,
  getFile: getSavedFileRow,
  identityChecked: () => identityRecentlyChecked(),
  materialize: materializeSavedFile,
  fetch: (url: string, init: RequestInit) => fetch(url, init),
};

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export function createSavedFileGet(overrides: Partial<typeof savedFileRouteDefaults> = {}) {
  const deps = { ...savedFileRouteDefaults, ...overrides };
  return async function GET(req: Request, fileId: string): Promise<Response> {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'saved-file',
        limit: 60,
        windowMs: 60_000,
      });
      const preview = new URL(req.url).searchParams.get('preview') === '1';
      const row = await deps.getFile(user.userId, fileId);
      if (!row) return json({ ok: false, error: 'This file is not in Files.' }, 404);
      if (!row.sealedFields?.length) {
        if (!row.url) return json({ ok: false, error: 'This file is not in storage any more.' }, 404);
        const upstream = await deps.fetch(row.url, {
          redirect: 'error',
          signal: AbortSignal.timeout(45_000),
        });
        if (!upstream.ok || !upstream.body)
          return json({ ok: false, error: 'The file could not be read.' }, 502);
        return new Response(upstream.body, {
          headers: savedFileHeaders({
            contentType: row.contentType,
            name: row.name,
            preview,
            size: row.size,
          }),
        });
      }
      // A sealed file: the check comes before any value is opened.
      if (!(await deps.identityChecked())) return verifyIdentityResponse();
      const file = await deps.materialize(user.userId, row._id, { kind: 'download', checked: true });
      return new Response(new Uint8Array(file.bytes), {
        headers: savedFileHeaders({
          contentType: file.contentType,
          name: file.name,
          preview,
          size: file.bytes.byteLength,
        }),
      });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      if (error instanceof SealedFileError) {
        if (error.code === 'verify_identity') return verifyIdentityResponse();
        return json(
          { ok: false, code: error.code, error: error.message },
          error.code === 'not_found' ? 404 : 409,
        );
      }
      const status = error instanceof AuthRequiredError ? 401 : error instanceof SavedFileError ? 404 : 500;
      return json(
        {
          ok: false,
          error: errorAnswerMessage(status, error, 'The file could not be read.', '[saved-file] failed'),
        },
        status,
      );
    }
  };
}

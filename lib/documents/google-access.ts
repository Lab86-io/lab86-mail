// Google answers 403 for several causes: the app is not on the file, the user
// has no write access, the token has no scope for the call, a rate limit, or a
// storage quota. Albatross asks for drive.file, not the full drive scope, so a
// Drive write to a file that it did not make fails with
// `appNotAuthorizedToFile`
// (https://developers.google.com/workspace/drive/api/guides/handle-errors).
// Only that reason gets the "Albatross did not make this file" handling. A
// missing scope (`insufficientPermissions`, `ACCESS_TOKEN_SCOPE_INSUFFICIENT`)
// means that the user did not allow write access at consent, so it keeps the
// reconnect error, as does each other 403
// (docs/google-verification/scopes.md, owner note 2).

/** Reasons that mean that the app is not on the file: Albatross did not make it. */
export const GOOGLE_APP_ACCESS_DENIED_REASONS: ReadonlySet<string> = new Set(['appNotAuthorizedToFile']);

/** Every error reason in a Google error body: `error.errors[].reason` and `error.details[].reason`. */
export function googleErrorReasons(payload: unknown): string[] {
  const error = (payload as { error?: { errors?: unknown; details?: unknown } } | null)?.error;
  const reasons: string[] = [];
  for (const list of [error?.errors, error?.details]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const reason = (entry as { reason?: unknown } | null)?.reason;
      if (typeof reason === 'string' && reason) reasons.push(reason);
    }
  }
  return reasons;
}

/** True when a Google answer is a 403 because the app is not on the file. */
export function isGoogleAppAccessDenied(status: number, reasons: readonly string[]): boolean {
  return status === 403 && reasons.some((reason) => GOOGLE_APP_ACCESS_DENIED_REASONS.has(reason));
}

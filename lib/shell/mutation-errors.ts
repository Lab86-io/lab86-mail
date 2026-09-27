/**
 * The global fallback for mutations that fail with no handler of their own.
 * A mutation with its own `onError` shows its own message, and a mutation
 * that renders its error inline sets `meta: { errorToast: false }`.
 */
export type MutationErrorMeta = {
  /** `false` skips the fallback; a string replaces the fallback text. */
  errorToast?: false | string;
};

type MutationLike = {
  options: { onError?: unknown };
  meta?: Record<string, unknown> | undefined;
};

export const MUTATION_FALLBACK_MESSAGE = 'That did not save. Try again.';

/** The text for a failed mutation, or null when the fallback must stay quiet. */
export function mutationFallbackMessage(error: unknown, mutation: MutationLike): string | null {
  if (typeof mutation.options.onError === 'function') return null;
  const meta = (mutation.meta || {}) as MutationErrorMeta;
  if (meta.errorToast === false) return null;
  if (error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError') return null;
  if (typeof meta.errorToast === 'string' && meta.errorToast.trim()) return meta.errorToast.trim();
  const message = error instanceof Error ? error.message.trim() : '';
  // Transport fallbacks name the tool (`archive_thread failed (500)`); they
  // are not useful to a person, so show the plain message instead.
  if (!message || /^[a-z0-9_]+ (failed|did not complete)\b/.test(message)) return MUTATION_FALLBACK_MESSAGE;
  return message;
}

export function createMutationErrorFallback(notify: (message: string) => void) {
  return (error: unknown, _variables: unknown, _context: unknown, mutation: MutationLike) => {
    const message = mutationFallbackMessage(error, mutation);
    if (message) notify(message);
  };
}

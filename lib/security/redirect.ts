// Sanitize internal redirect paths for OAuth flows. Only same-origin paths
// may round-trip through OAuth state: protocol-relative (//evil.com),
// absolute URLs, and backslash tricks all fall back to '/'.
export const NATIVE_NYLAS_CALLBACK = 'lab86-native-callback';

const INTERNAL_ORIGIN = 'https://internal.invalid';

export function sanitizeInternalPath(value: string | null | undefined): string {
  if (!value) return '/';
  // The URL parser drops tab and newline characters, so "/<TAB>/evil.com"
  // becomes "//evil.com". A path with any control character is refused.
  if (/[\u0000-\u001f\u007f]/.test(value)) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/';
  }
  // The parsed URL must stay on this origin.
  const parsed = URL.canParse(value, INTERNAL_ORIGIN) ? new URL(value, INTERNAL_ORIGIN) : null;
  if (parsed?.origin !== INTERNAL_ORIGIN) return '/';
  return value;
}

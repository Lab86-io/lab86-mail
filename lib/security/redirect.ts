// Sanitize internal redirect paths for OAuth flows. Only same-origin paths
// may round-trip through OAuth state: protocol-relative (//evil.com),
// absolute URLs, and backslash tricks all fall back to '/'.
export function sanitizeInternalPath(value: string | null | undefined): string {
  if (!value) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes(':')) {
    return '/';
  }
  return value;
}

// Forgiving URL normalization for user/agent-supplied links. Accepts
// "example.com", "www.x.com/a", "https://x.com" alike and returns a usable
// absolute https URL, or null when it can't be salvaged.
export function normalizeUrl(input: string): string | null {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;
  // Leave well-formed absolute URLs (any scheme) as-is.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).toString();
    } catch {
      return null;
    }
  }
  // mailto: and other no-slash schemes pass through untouched.
  if (/^(mailto|tel):/i.test(trimmed)) return trimmed;
  // Bare host/path → assume https.
  try {
    const url = new URL(`https://${trimmed}`);
    // Reject inputs with no dotted host (e.g. plain words) so we don't turn
    // "notes" into a link.
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.host ? url.toString() : null;
  } catch {
    return null;
  }
}

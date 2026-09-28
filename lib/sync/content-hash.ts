// Change detection for sync writers. Convex bills each read and each write by
// the whole document, so a sync pass that rewrites unchanged rows pays for
// every row on every tick. These helpers let a writer compare the incoming
// row with the stored row and skip the write when the content is equal.

/** A copy of a JSON-like value with object keys in sorted order. */
export function orderedContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedContent);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, orderedContent(entry)]),
    );
  return value;
}

/** A stable string for a JSON-like value. Key order and undefined keys do not change it. */
export function stableContent(value: unknown): string {
  return JSON.stringify(orderedContent(value)) ?? 'undefined';
}

/** A 64-bit string hash (cyrb53). It detects changed rows; it is not security. */
export function stableHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The hash of a JSON-like value. Key order and undefined keys do not change it. */
export function contentHash(value: unknown): string {
  return stableHash(stableContent(value));
}

/**
 * True when each key has the same content on the stored row and on the next
 * row. A key that is missing on one side and undefined on the other is equal.
 */
export function sameFields(
  stored: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  if (!stored) return false;
  return keys.every((key) => stableContent(stored[key]) === stableContent(next[key]));
}

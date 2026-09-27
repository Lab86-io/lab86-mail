/**
 * A raw thought, dumped fast (text or voice), is saved as one intent by
 * default. If the dump looks like several things, capture asks before it
 * splits.
 */

/**
 * Split a raw dump into candidate intents. Conservative: only splits on
 * strong separators (new lines, numbered/bulleted lists, " and then ",
 * semicolons). Returns the original text as a single item when nothing
 * clearly separates it.
 */
export function splitIntentText(text: string): string[] {
  const normalized = text.replace(/\r/g, '');
  const pieces = normalized
    .split(/\n+|\s*;\s*|\s+and then\s+|^\s*\d+[.)]\s+|\s*[•\-*]\s+/gim)
    .map((piece) => piece.trim().replace(/^and then\s+/i, ''))
    .filter((piece) => piece.length >= 3);
  if (pieces.length <= 1) return [text.trim()].filter(Boolean);
  // De-duplicate while preserving order.
  const seen = new Set<string>();
  const unique = pieces.filter((piece) => {
    const key = piece.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique;
}

export function looksLikeMultipleIntents(text: string): boolean {
  return splitIntentText(text).length > 1;
}

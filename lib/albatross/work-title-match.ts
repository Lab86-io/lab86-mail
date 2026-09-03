// Find one Work by the words the user used for it.
//
// "add Blade Runner to the movie list" names the Work as "movie list". The
// stored title may be "Movie list" or "Movies to watch". The match is plain:
// exact first, then containment, then shared words. No model call.

export interface TitledWorkLike {
  _id: string;
  title?: string | null;
  rawText?: string | null;
  shape?: string | null;
  workState?: string | null;
  status?: string | null;
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'my', 'of', 'to', 'for', 'list', 'and']);

function normalize(value: string | null | undefined): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A plain stem: "movies" and "movie" are one word. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

function words(value: string): string[] {
  return normalize(value)
    .split(' ')
    .filter((word) => word && !STOP_WORDS.has(word))
    .map(stem);
}

function isOpen(row: TitledWorkLike): boolean {
  const state = row.workState || row.status || 'active';
  return !['done', 'released', 'archived'].includes(state);
}

/** A score in [0, 1]. Zero means no match. */
export function titleMatchScore(row: TitledWorkLike, query: string): number {
  const wanted = normalize(query);
  if (!wanted) return 0;
  const title = normalize(row.title) || normalize(row.rawText).slice(0, 120);
  if (!title) return 0;
  if (title === wanted) return 1;
  if (title.includes(wanted) || wanted.includes(title)) return 0.9;
  const have = new Set(words(title));
  const want = words(wanted);
  if (!want.length || !have.size) return 0;
  const shared = want.filter((word) => have.has(word)).length;
  return shared ? 0.5 * (shared / want.length) + 0.3 * (shared / have.size) : 0;
}

/**
 * The one open Work that best matches the words, or null. A shape filter
 * keeps "the movie list" from landing on a project that mentions movies.
 * A tie between two equal scores is no match: the caller must ask.
 */
export function resolveWorkByTitle<T extends TitledWorkLike>(
  rows: T[],
  query: string,
  options: { shape?: string; minScore?: number } = {},
): T | null {
  const minScore = options.minScore ?? 0.4;
  const ranked = rows
    .filter((row) => isOpen(row) && (!options.shape || row.shape === options.shape))
    .map((row) => ({ row, score: titleMatchScore(row, query) }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0].score === ranked[1].score && ranked[0].score < 1) return null;
  return ranked[0].row;
}

import { safeSlice, stripLoneSurrogates } from './text';

// The brief hydration contract caps a title at 500 characters and a subtitle
// at 1,000 (lib/shared/brief-hydration.ts). The Convex resolvers copied raw
// subjects, locations, and descriptions into those fields, so one long row
// made the whole /api/mobile/v1/briefs response a 500. The cut lands on a
// word boundary and never splits a surrogate pair.

export const BRIEF_ENTITY_TITLE_MAX = 500;
export const BRIEF_ENTITY_SUBTITLE_MAX = 1_000;

/** Cuts `value` to at most `max` UTF-16 code units at the last word boundary
 * in the first half of the cut, or at the cut itself when there is none. */
export function cutAtWord(value: string, max: number): string {
  const text = stripLoneSurrogates(value);
  if (text.length <= max) return text;
  const head = safeSlice(text, 0, max);
  const boundary = lastWhitespace(head);
  const cut = boundary >= Math.floor(max / 2) ? safeSlice(head, 0, boundary) : head;
  return cut.trimEnd();
}

// Any whitespace is a word boundary: a subject or a description can break
// on a newline or a tab as well as a space.
function lastWhitespace(text: string): number {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (/\s/.test(text[index] ?? '')) return index;
  }
  return -1;
}

/** The title of a hydrated brief entity: the value, or the fallback when the
 * value is empty, within the contract cap. */
export function briefEntityTitle(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return cutAtWord(text || fallback, BRIEF_ENTITY_TITLE_MAX) || fallback;
}

/** The subtitle of a hydrated brief entity, within the contract cap, or
 * undefined when there is nothing to say. */
export function briefEntitySubtitle(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return undefined;
  return cutAtWord(text, BRIEF_ENTITY_SUBTITLE_MAX) || undefined;
}

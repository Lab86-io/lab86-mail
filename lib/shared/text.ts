// UTF-16 safe text cuts. A plain `.slice(0, n)` can cut between the two halves
// of a surrogate pair (an emoji, for example). The result then holds a lone
// surrogate, and Convex rejects it as an argument, a return value, or a stored
// value. These helpers never split a pair.

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff;
}

function sliceIndex(index: number, length: number) {
  const value = Math.trunc(Number(index)) || 0;
  return value < 0 ? Math.max(0, length + value) : Math.min(value, length);
}

/** Same as `String.prototype.slice`, but the result never starts on a low
 * surrogate and never ends right after a high surrogate. The result is always
 * a substring of the plain slice, so a length limit still holds. */
export function safeSlice(text: string, start = 0, end?: number): string {
  let from = sliceIndex(start, text.length);
  let to = end === undefined ? text.length : sliceIndex(end, text.length);
  if (from >= to) return '';
  if (isLowSurrogate(text.charCodeAt(from))) from += 1;
  if (to > from && isHighSurrogate(text.charCodeAt(to - 1))) to -= 1;
  return text.slice(from, to);
}

/** The first `max` UTF-16 code units of `text`, without a split surrogate pair.
 * A nullish value passes through, like `text?.slice(0, max)`. */
export function truncateText(text: string, max: number): string;
export function truncateText<T extends null | undefined>(text: string | T, max: number): string | T;
export function truncateText(text: string | null | undefined, max: number) {
  return text == null ? text : safeSlice(text, 0, max);
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Last-resort sanitizer for provider text: replaces each lone surrogate with
 * U+FFFD so a malformed source string can never reach Convex. */
export function stripLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE, '\uFFFD');
}

/** `stripLoneSurrogates` for each string (and each key) in a plain JSON-like
 * value, such as a normalized provider message. Other values pass through. */
export function stripLoneSurrogatesDeep<T>(value: T): T {
  if (typeof value === 'string') return stripLoneSurrogates(value) as T;
  if (Array.isArray(value)) return value.map((item) => stripLoneSurrogatesDeep(item)) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [stripLoneSurrogates(key), stripLoneSurrogatesDeep(item)]),
    ) as T;
  return value;
}

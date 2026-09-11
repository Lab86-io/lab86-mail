// Text reveal metering (docs/chat-agentic-pass.md, section 4).
//
// The stream delivers text in chunks of several words. The client keeps the
// full buffer and a cursor, and releases one word per tick so the words appear
// one at a time. When the backlog grows past the threshold the release rate
// rises so the reveal never lags far behind the stream. When the stream ends
// the rest drains within the drain budget. This file is the pure core; the
// hook in components/ui/metered-text.ts owns the timer.

/** Base cadence: one word every 18 ms. */
export const WORD_CADENCE_MS = 18;
/** Above this backlog the reveal releases more than one word per tick. */
export const CATCH_UP_BACKLOG_WORDS = 40;
/** The reveal stays within about this far behind the stream. */
export const MAX_LAG_MS = 600;
/** After the stream ends, the rest of the text drains within this budget. */
export const DRAIN_MS = 400;

function isSpace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\r';
}

/** Index just past the next word after `cursor`, skipping leading whitespace. */
export function nextWordEnd(text: string, cursor: number): number {
  const length = text.length;
  let index = Math.max(0, cursor);
  while (index < length && isSpace(text[index])) index += 1;
  while (index < length && !isSpace(text[index])) index += 1;
  return index;
}

/** Number of words in `text` at or after `cursor`. */
export function countWords(text: string, cursor = 0): number {
  let count = 0;
  let index = Math.max(0, cursor);
  while (index < text.length) {
    const next = nextWordEnd(text, index);
    if (next === index || !text.slice(index, next).trim()) break;
    count += 1;
    index = next;
  }
  return count;
}

/**
 * Words one tick releases. One word at the base cadence; more when the
 * backlog is large so the lag stays under MAX_LAG_MS; and enough to drain
 * within DRAIN_MS once the stream has finished.
 */
export function wordsPerTick(backlogWords: number, finished: boolean): number {
  if (backlogWords <= 0) return 1;
  if (finished) return Math.max(1, Math.ceil(backlogWords / (DRAIN_MS / WORD_CADENCE_MS)));
  if (backlogWords > CATCH_UP_BACKLOG_WORDS) {
    return Math.max(2, Math.ceil(backlogWords / (MAX_LAG_MS / WORD_CADENCE_MS)));
  }
  return 1;
}

/**
 * The cursor after one tick. Releases `wordsPerTick` words and the whitespace
 * that follows them, so the next tick starts on a word. Returns the text
 * length when nothing but whitespace remains.
 */
export function nextRevealCursor(
  text: string,
  cursor: number,
  backlogWords: number,
  finished: boolean,
): number {
  const length = text.length;
  if (cursor >= length) return length;
  const words = wordsPerTick(backlogWords, finished);
  let next = Math.max(0, cursor);
  for (let released = 0; released < words; released += 1) {
    const end = nextWordEnd(text, next);
    if (end === next) return length;
    next = end;
  }
  while (next < length && isSpace(text[next])) next += 1;
  return next;
}

export interface RevealProgress {
  cursor: number;
  deadline: number | null;
  finished: boolean;
}

/** Use a fixed deadline, so each tick does not restart the drain budget. */
export function advanceReveal(
  text: string,
  progress: RevealProgress,
  now: number,
  finished: boolean,
): RevealProgress {
  const cursor = Math.min(progress.cursor, text.length);
  const backlog = countWords(text, cursor);
  let deadline = progress.deadline;
  if (finished && !progress.finished) deadline = Math.min(deadline ?? Infinity, now + DRAIN_MS);
  if (!finished && backlog > CATCH_UP_BACKLOG_WORDS && deadline == null) deadline = now + MAX_LAG_MS;
  const remaining = deadline == null ? undefined : Math.max(0, deadline - now);
  const stepWords =
    remaining == null ? 1 : Math.max(1, Math.ceil(backlog / Math.max(1, remaining / WORD_CADENCE_MS)));
  let next = cursor;
  for (let i = 0; i < stepWords && next < text.length; i += 1) next = nextWordEnd(text, next);
  while (next < text.length && isSpace(text[next])) next += 1;
  if (remaining === 0) next = text.length;
  return { cursor: next, deadline: next === text.length ? null : deadline, finished };
}

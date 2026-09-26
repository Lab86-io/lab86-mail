// PAGE-1. Thread lists page by a `lastDate` watermark in whole seconds, and
// the next page reads `lastDate < watermark`. When a page ends inside a group
// of threads with the same time, that read would skip the rest of the group.
// So a page never ends inside a group: it grows to hold the whole group, and
// the watermark stays a plain number that every client already accepts.

/**
 * Cuts one page from rows sorted newest first. `rows` must hold every row
 * that shares the boundary time (the caller fetches the group when needed).
 */
export function pageThroughTies<T>(
  rows: T[],
  limit: number,
  dateOf: (row: T) => number,
): { page: T[]; nextBefore: number | undefined } {
  if (rows.length <= limit) return { page: rows, nextBefore: undefined };
  let end = limit;
  const boundary = dateOf(rows[limit - 1]);
  while (end < rows.length && dateOf(rows[end]) === boundary) end += 1;
  const page = rows.slice(0, end);
  const nextBefore = end < rows.length && boundary > 0 ? boundary : undefined;
  return { page, nextBefore };
}

/** True when the row after the page shares the boundary time. */
export function pageEndsInTie<T>(rows: T[], limit: number, dateOf: (row: T) => number) {
  return rows.length > limit && limit > 0 && dateOf(rows[limit]) === dateOf(rows[limit - 1]);
}

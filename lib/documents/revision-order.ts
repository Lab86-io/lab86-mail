/**
 * A read can start before a save and end after it. The older answer must not
 * replace the saved revision, or the next save fails with a conflict.
 */
export function newestDocumentAnswer<T extends { document: { currentRevision: number } }>(
  cached: T | undefined,
  fresh: T,
): T {
  return cached && cached.document.currentRevision > fresh.document.currentRevision ? cached : fresh;
}

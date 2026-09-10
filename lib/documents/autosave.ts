import type { AlbatrossDocumentModel } from './model';

export function documentDraftMatchesSave(
  latest: { title: string; model: AlbatrossDocumentModel | null },
  saved: { title: string; model: AlbatrossDocumentModel },
) {
  return latest.title === saved.title && latest.model === saved.model;
}

/** A proposal may cross an autosave/refetch boundary, but never newer edits. */
export function documentSuggestionMatchesDraft(
  latest: { title: string; model: AlbatrossDocumentModel | null },
  base: { title: string; model: AlbatrossDocumentModel },
) {
  return (
    latest.model !== null &&
    latest.title === base.title &&
    JSON.stringify(latest.model) === JSON.stringify(base.model)
  );
}

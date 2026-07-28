import type { AlbatrossDocumentModel } from './model';

export function documentDraftMatchesSave(
  latest: { title: string; model: AlbatrossDocumentModel | null },
  saved: { title: string; model: AlbatrossDocumentModel },
) {
  return latest.title === saved.title && latest.model === saved.model;
}

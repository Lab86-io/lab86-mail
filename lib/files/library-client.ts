import { z } from 'zod';
import type { CloudFileItem } from './providers';

const itemSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.enum(['albatross', 'google_drive', 'onedrive', 'icloud']),
  isFolder: z.boolean(),
  connectionId: z.string().optional(),
  documentId: z.string().optional(),
  documentKind: z.enum(['doc', 'sheet', 'deck']).optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  modifiedAt: z.number().finite().optional(),
  owner: z.string().optional(),
  webUrl: z.string().optional(),
  thumbnailUrl: z.string().optional(),
});
const pageSchema = z.object({
  ok: z.literal(true),
  items: z.array(itemSchema),
  nextCursor: z.string().nullable().optional(),
});
export interface FilePage {
  items: CloudFileItem[];
  nextCursor?: string | null;
}
export async function readFilePage(url: string, signal?: AbortSignal): Promise<FilePage> {
  const response = await fetch(url, { signal, cache: 'no-store' });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(typeof body?.error === 'string' ? body.error : 'Files could not refresh. Please retry.');
  const parsed = pageSchema.safeParse(body);
  if (!parsed.success) throw new Error('The file source returned an incomplete response. Please retry.');
  return parsed.data;
}
export function mergeFilePages(pages: FilePage[] = []) {
  return [
    ...new Map(
      pages
        .flatMap((page) => page.items)
        .map((item) => [`${item.provider}:${item.connectionId || ''}:${item.id}`, item]),
    ).values(),
  ];
}
export function fileMatchesType(item: CloudFileItem, type: string) {
  if (type === 'all') return true;
  if (type === 'folders') return item.isFolder;
  if (type === 'images') return item.mimeType?.startsWith('image/');
  if (type === 'pdf') return item.mimeType === 'application/pdf';
  return /document|spreadsheet|presentation|text\//.test(item.mimeType || '');
}

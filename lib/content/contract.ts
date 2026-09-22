import { z } from 'zod';

export const CONTENT_VERSION = 1;
export const MAX_CONTENT_CHARS = 120_000;
export const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
export const contentLabelsSchema = z.object({
  kind: z.enum(['request', 'requirements', 'decision', 'meeting', 'reference', 'update', 'noise']),
  actionable: z.boolean(),
  resolved: z.boolean(),
  workId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  model: z.string(),
  evaluatedAt: z.number(),
});
export type ContentLabels = z.infer<typeof contentLabelsSchema>;
export interface ContentItem {
  _id: string;
  key: string;
  connectionId: string;
  source: string;
  externalId: string;
  title: string;
  text: string;
  url?: string;
  version: string;
  modifiedAt: number;
  indexedAt: number;
  partial: boolean;
  labels?: ContentLabels;
  ownerIdentities?: string[];
}
export const preparedDraftSchema = z.object({
  title: z.string().min(1).max(180),
  shape: z.enum(['quick', 'list', 'project', 'practice', 'decision', 'monitor', 'recurring']),
  situation: z.string().min(1).max(1600),
  background: z.string().max(2400),
  assessment: z.string().max(2400),
  recommendation: z.string().min(1).max(1600),
  questions: z.array(z.string().min(1).max(500)).max(5),
  steps: z.array(z.string().min(1).max(500)).max(8),
  files: z
    .array(
      z.object({
        name: z
          .string()
          .min(1)
          .max(120)
          .regex(/^[A-Za-z0-9 _.-]+\.(md|txt|csv)$/),
        content: z.string().min(1).max(30_000),
      }),
    )
    .max(3),
  evidence: z
    .array(z.object({ sourceId: z.string(), quote: z.string().min(1).max(800) }))
    .min(1)
    .max(12),
});
export type PreparedDraft = z.infer<typeof preparedDraftSchema>;

export function contentChunks(text: string): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < Math.min(text.length, MAX_CONTENT_CHARS); offset += 3600) {
    result.push(text.slice(offset, offset + 4000));
  }
  return result;
}

/** Search and research excerpts retain exact source text, including matches
 * late in long documents. These excerpts never stand in for full coverage. */
export function contentExcerpt(text: string, query: string, limit = 1800) {
  const lower = text.toLocaleLowerCase();
  const words = query.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
  const positions = words
    .filter((word) => !['the', 'and', 'for', 'with', 'what', 'where', 'from'].includes(word))
    .map((word) => lower.indexOf(word))
    .filter((position) => position >= 0);
  const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 160);
  return `${start ? '…' : ''}${text.slice(start, start + limit)}${start + limit < text.length ? '…' : ''}`;
}
export function researchExcerpt(text: string, queries: string[]) {
  if (text.length <= 12_000) return text;
  return [
    text.slice(0, 3000),
    ...queries.slice(0, 3).map((query) => contentExcerpt(text, query, 2200)),
    text.slice(-2000),
  ]
    .join('\n\n[Excerpt]\n\n')
    .slice(0, 12_000);
}
export function sourceLink(item: Pick<ContentItem, 'source' | 'connectionId' | 'externalId' | 'url'>) {
  if (item.source === 'attachment') {
    try {
      const [messageId, attachmentId] = JSON.parse(item.externalId);
      if (typeof messageId !== 'string' || typeof attachmentId !== 'string') return null;
      return `/api/attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}?account=${encodeURIComponent(item.connectionId)}`;
    } catch {
      return null;
    }
  }
  if (item.source === 'mail')
    return `/?view=mail&account=${encodeURIComponent(item.connectionId)}&thread=${encodeURIComponent(item.externalId)}`;
  if (item.source === 'document') return `/?view=files&document=${encodeURIComponent(item.externalId)}`;
  try {
    const url = new URL(item.url || '');
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
export function validatePreparedEvidence(draft: PreparedDraft, sources: ContentItem[]) {
  const byId = new Map(sources.map((source) => [source._id, source]));
  for (const evidence of draft.evidence) {
    const source = byId.get(evidence.sourceId);
    if (!source?.text.includes(evidence.quote)) throw new Error('Draft evidence did not match its source.');
  }
  return draft;
}

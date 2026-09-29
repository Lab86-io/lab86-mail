import { z } from 'zod';
import { safeSlice, truncateText } from '../shared/text';

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
/** The limits of a stored prepared draft. */
export const PREPARED_DRAFT_LIMITS = {
  title: 180,
  situation: 1600,
  background: 2400,
  assessment: 2400,
  recommendation: 1600,
  questions: 5,
  question: 500,
  steps: 8,
  step: 500,
  files: 3,
  fileName: 120,
  fileContent: 30_000,
  evidence: 12,
  quote: 800,
} as const;
const L = PREPARED_DRAFT_LIMITS;
const PREPARED_SHAPES = ['quick', 'list', 'project', 'practice', 'decision', 'monitor', 'recurring'] as const;
const PREPARED_FILE_NAME = /^[A-Za-z0-9 _.-]+\.(md|txt|csv)$/;

export const preparedDraftSchema = z.object({
  title: z.string().min(1).max(L.title),
  shape: z.enum(PREPARED_SHAPES),
  situation: z.string().min(1).max(L.situation),
  background: z.string().max(L.background),
  assessment: z.string().max(L.assessment),
  recommendation: z.string().min(1).max(L.recommendation),
  questions: z.array(z.string().min(1).max(L.question)).max(L.questions),
  steps: z.array(z.string().min(1).max(L.step)).max(L.steps),
  files: z
    .array(
      z.object({
        name: z.string().min(1).max(L.fileName).regex(PREPARED_FILE_NAME),
        content: z.string().min(1).max(L.fileContent),
      }),
    )
    .max(L.files),
  evidence: z
    .array(z.object({ sourceId: z.string(), quote: z.string().min(1).max(L.quote) }))
    .min(1)
    .max(L.evidence),
});
export type PreparedDraft = z.infer<typeof preparedDraftSchema>;

// The schema the model receives. Anthropic structured output (also through
// OpenRouter) does not enforce maxItems, maxLength, minLength or pattern, so
// Opus returned longer lists than the stored draft allows and every
// preparation failed after a paid call. The model reads the limits in the
// descriptions; fitPreparedDraft applies them before the stored schema.
export const preparedDraftModelSchema = z.object({
  title: z.string().describe(`A short title, at most ${L.title} characters.`),
  shape: z.enum(PREPARED_SHAPES),
  situation: z.string().describe(`At most ${L.situation} characters.`),
  background: z.string().describe(`At most ${L.background} characters.`),
  assessment: z.string().describe(`At most ${L.assessment} characters.`),
  recommendation: z.string().describe(`At most ${L.recommendation} characters.`),
  questions: z
    .array(z.string())
    .describe(`At most ${L.questions} questions, each at most ${L.question} characters.`),
  steps: z.array(z.string()).describe(`At most ${L.steps} steps, each at most ${L.step} characters.`),
  files: z
    .array(z.object({ name: z.string(), content: z.string() }))
    .describe(
      `At most ${L.files} files. A name uses letters, digits, spaces, _ . - and ends in .md, .txt or .csv.`,
    ),
  evidence: z
    .array(z.object({ sourceId: z.string(), quote: z.string() }))
    .describe(`1 to ${L.evidence} exact quotes, each at most ${L.quote} characters.`),
});
export type PreparedDraftModelOutput = z.infer<typeof preparedDraftModelSchema>;

function fitText(value: string, max: number) {
  return truncateText(value.trim(), max);
}

function fitList(values: string[], count: number, max: number) {
  return values
    .map((value) => fitText(value, max))
    .filter(Boolean)
    .slice(0, count);
}

function fitFileName(name: string) {
  const extension = /\.(md|txt|csv)$/i.exec(name.trim())?.[1]?.toLowerCase() ?? 'md';
  const stem = name
    .trim()
    .replace(/\.(md|txt|csv)$/i, '')
    .replace(/[^A-Za-z0-9 _.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-. ]+|[-. ]+$/g, '');
  return `${stem.slice(0, L.fileName - extension.length - 1) || 'draft'}.${extension}`;
}

/**
 * The model output inside the stored limits: text is cut to its limit, empty
 * list entries are removed, lists keep their first entries, and file names
 * keep only the allowed characters. A quote keeps its start, so it stays an
 * exact quote of its source. When the evidence list is too long, one quote of
 * the trigger source stays in it.
 */
export function fitPreparedDraft(output: PreparedDraftModelOutput, triggerSourceId?: string): PreparedDraft {
  const evidence = output.evidence
    .map((entry) => ({ sourceId: entry.sourceId, quote: fitText(entry.quote, L.quote) }))
    .filter((entry) => entry.quote);
  let kept = evidence.slice(0, L.evidence);
  const trigger = evidence.find((entry) => entry.sourceId === triggerSourceId);
  if (trigger && !kept.includes(trigger)) kept = [...kept.slice(0, L.evidence - 1), trigger];
  return {
    title: fitText(output.title, L.title),
    shape: output.shape,
    situation: fitText(output.situation, L.situation),
    background: fitText(output.background, L.background),
    assessment: fitText(output.assessment, L.assessment),
    recommendation: fitText(output.recommendation, L.recommendation),
    questions: fitList(output.questions, L.questions, L.question),
    steps: fitList(output.steps, L.steps, L.step),
    files: output.files
      .map((file) => ({ name: fitFileName(file.name), content: truncateText(file.content, L.fileContent) }))
      .filter((file) => file.content.trim())
      .slice(0, L.files),
    evidence: kept,
  };
}

const PREPARATION_RETRY_BASE_MS = 10 * 60_000;
const PREPARATION_RETRY_MAX_MS = 24 * 3_600_000;

/**
 * The wait before the next attempt of a preparation that failed `failures`
 * times in a row: 10 minutes, then double for each failure, at most one day.
 * A fixed 10 minute retry of a failure that repeats sent two paid calls to
 * the model every 10 minutes, all day.
 */
export function preparationRetryDelayMs(failures: number) {
  const count = Math.max(1, Math.floor(Number(failures) || 1));
  return Math.min(PREPARATION_RETRY_MAX_MS, PREPARATION_RETRY_BASE_MS * 2 ** Math.min(count - 1, 20));
}

export const RESEARCH_QUERY_LIMIT = 4;
export const RESEARCH_QUERY_CHARS = 160;
export const researchPlanModelSchema = z.object({
  queries: z
    .array(z.string())
    .describe(
      `${RESEARCH_QUERY_LIMIT} or fewer targeted search queries, each at most ${RESEARCH_QUERY_CHARS} characters.`,
    ),
});

/** The first distinct research queries, cut to the query limit. */
export function fitResearchQueries(queries: string[]) {
  const seen = new Set<string>();
  const fitted: string[] = [];
  for (const query of queries) {
    const text = fitText(query, RESEARCH_QUERY_CHARS);
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    fitted.push(text);
    if (fitted.length === RESEARCH_QUERY_LIMIT) break;
  }
  return fitted;
}

/** Model text with prose or a code fence around one JSON object: the object alone. */
export async function extractJsonObjectText({ text }: { text: string }): Promise<string | null> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

export function contentChunks(text: string): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < Math.min(text.length, MAX_CONTENT_CHARS); offset += 3600) {
    result.push(safeSlice(text, offset, offset + 4000));
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
  return `${start ? '…' : ''}${safeSlice(text, start, start + limit)}${start + limit < text.length ? '…' : ''}`;
}
export function researchExcerpt(text: string, queries: string[]) {
  if (text.length <= 12_000) return text;
  return truncateText(
    [
      truncateText(text, 3000),
      ...queries.slice(0, 3).map((query) => contentExcerpt(text, query, 2200)),
      safeSlice(text, -2000),
    ].join('\n\n[Excerpt]\n\n'),
    12_000,
  );
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

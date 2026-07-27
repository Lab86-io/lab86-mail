import { randomUUID } from 'node:crypto';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import {
  type AlbatrossDocumentModel,
  type AlbatrossDocumentRecord,
  createDefaultDocumentModel,
  type DocumentKind,
  type DocumentSourceRef,
  type DocumentSuggestion,
  parseDocumentModel,
} from './model';

const documentsApi = (api as any).documents;

export interface DocumentWithSuggestions extends AlbatrossDocumentRecord {
  suggestions: DocumentSuggestion[];
}

export async function createDocument(input: {
  userId: string;
  kind: DocumentKind;
  title?: string;
  model?: unknown;
  sourceRefs?: DocumentSourceRef[];
  reason?: string;
}) {
  const documentId = randomUUID();
  const model = input.model
    ? parseDocumentModel(input.model, input.kind)
    : createDefaultDocumentModel(input.kind, documentId);
  return convexMutation<AlbatrossDocumentRecord>(documentsApi.create, {
    userId: input.userId,
    documentId,
    kind: input.kind,
    title:
      String(input.title || '')
        .trim()
        .slice(0, 500) || 'Untitled',
    model,
    sourceRefs: input.sourceRefs || [],
    reason: input.reason,
  });
}

export async function listDocuments(input: { userId: string; kind?: DocumentKind; limit?: number }) {
  const rows = await convexQuery<AlbatrossDocumentRecord[]>(documentsApi.list, input);
  return rows.map((row) => ({ ...row, model: parseDocumentModel(row.model, row.kind) }));
}

export async function getDocument(userId: string, documentId: string) {
  const row = await convexQuery<DocumentWithSuggestions | null>(documentsApi.get, { userId, documentId });
  if (!row) return null;
  return {
    ...row,
    model: parseDocumentModel(row.model, row.kind),
    suggestions: (row.suggestions || []).map((suggestion) => ({
      ...suggestion,
      proposedModel: parseDocumentModel(suggestion.proposedModel, row.kind),
    })),
  };
}

export async function findDocumentByGoogleFile(input: {
  userId: string;
  connectionId: string;
  fileId: string;
}) {
  const row = await convexQuery<AlbatrossDocumentRecord | null>(documentsApi.findByGoogleFile, input);
  return row ? { ...row, model: parseDocumentModel(row.model, row.kind) } : null;
}

export async function updateDocument(input: {
  userId: string;
  documentId: string;
  expectedRevision: number;
  title?: string;
  model?: unknown;
  sourceRefs?: DocumentSourceRef[];
  reason?: string;
  actor?: 'user' | 'ai' | 'system';
}) {
  const current = input.model === undefined ? null : await getDocument(input.userId, input.documentId);
  if (input.model !== undefined && !current) return { ok: false as const, code: 'NOT_FOUND' as const };
  const model = input.model === undefined ? undefined : parseDocumentModel(input.model, current!.kind);
  return convexMutation<
    | { ok: true; document: AlbatrossDocumentRecord }
    | {
        ok: false;
        code: 'NOT_FOUND' | 'REVISION_CONFLICT';
        document?: AlbatrossDocumentRecord;
      }
  >(documentsApi.update, {
    userId: input.userId,
    documentId: input.documentId,
    expectedRevision: input.expectedRevision,
    title: input.title?.trim().slice(0, 500),
    model,
    sourceRefs: input.sourceRefs,
    reason: input.reason,
    actor: input.actor,
  });
}

export async function archiveDocument(userId: string, documentId: string) {
  return convexMutation<{ ok: boolean }>(documentsApi.archive, { userId, documentId });
}

export async function createDocumentSuggestion(input: {
  userId: string;
  documentId: string;
  title: string;
  description: string;
  proposedModel: AlbatrossDocumentModel;
  sourceRefs?: DocumentSourceRef[];
}) {
  const suggestionId = randomUUID();
  const result = await convexMutation<{ ok: boolean; createdAt?: number }>(documentsApi.createSuggestion, {
    ...input,
    suggestionId,
  });
  return { ...result, suggestionId };
}

export async function resolveDocumentSuggestion(input: {
  userId: string;
  documentId: string;
  suggestionId: string;
  status: 'applied' | 'dismissed';
}) {
  return convexMutation<{ ok: boolean }>(documentsApi.resolveSuggestion, input);
}

export async function linkGoogleDocument(input: {
  userId: string;
  documentId: string;
  connectionId: string;
  fileId: string;
  mimeType: string;
  webUrl?: string;
  providerVersion?: string;
  syncedRevision: number;
}) {
  return convexMutation<{ ok: boolean; google?: AlbatrossDocumentRecord['google'] }>(
    documentsApi.linkGoogleFile,
    input,
  );
}

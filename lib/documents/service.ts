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
  parseSuggestionPayload,
  type SuggestionPayload,
} from './model';
import { assertModelWithinLimit } from './sheet-workbook';

const documentsApi = (api as any).documents;

const defaultDependencies = {
  convexMutation,
  convexQuery,
  randomUUID,
};

let dependencies = defaultDependencies;

export function __setDocumentServiceDepsForTest(overrides: Partial<typeof defaultDependencies> = {}) {
  dependencies = { ...defaultDependencies, ...overrides };
}

export interface DocumentWithSuggestions extends AlbatrossDocumentRecord {
  suggestions: DocumentSuggestion[];
}

export async function createDocument(input: {
  userId: string;
  /** Server-chosen idempotency identity for original-byte imports. */
  documentId?: string;
  kind: DocumentKind;
  title?: string;
  model?: unknown;
  sourceRefs?: DocumentSourceRef[];
  reason?: string;
  importSource?: {
    format: 'xlsx';
    filename: string;
    mimeType: string;
    size: number;
    sha256: string;
    storageId: string;
    warnings: string[];
    importedAt: number;
  };
}) {
  const documentId = input.documentId ?? dependencies.randomUUID();
  const model = input.model
    ? parseDocumentModel(input.model, input.kind)
    : createDefaultDocumentModel(input.kind, documentId);
  assertModelWithinLimit(model);
  return dependencies.convexMutation<AlbatrossDocumentRecord>(documentsApi.create, {
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
    importSource: input.importSource,
  });
}

export async function listDocuments(input: { userId: string; kind?: DocumentKind; limit?: number }) {
  const rows = await dependencies.convexQuery<AlbatrossDocumentRecord[]>(documentsApi.list, input);
  return rows.map((row) => ({ ...row, model: parseDocumentModel(row.model, row.kind) }));
}

export async function getDocument(userId: string, documentId: string) {
  const row = await dependencies.convexQuery<DocumentWithSuggestions | null>(documentsApi.get, {
    userId,
    documentId,
  });
  if (!row) return null;
  return {
    ...row,
    model: parseDocumentModel(row.model, row.kind),
    suggestions: (row.suggestions || []).map((suggestion) => ({
      ...suggestion,
      proposedModel: parseSuggestionPayload(suggestion.proposedModel, row.kind),
    })),
  };
}

export async function generateImportUploadUrl() {
  return dependencies.convexMutation<string>(documentsApi.generateImportUploadUrl, {});
}

export async function cancelDocumentImport(input: { userId: string; documentId: string; storageId: string }) {
  return dependencies.convexMutation<{
    status: 'attached' | 'cancelled';
    document?: AlbatrossDocumentRecord;
  }>(documentsApi.cancelImport, input);
}

export class DocumentImportUnconfirmedError extends Error {
  constructor() {
    super(
      'The import status could not be confirmed. Check Files before importing again; keep your original file until the import is verified.',
    );
    this.name = 'DocumentImportUnconfirmedError';
  }
}

/**
 * Bind a freshly uploaded original to one server-generated document identity.
 * If a response is lost, compensation either finds that exact committed import
 * or cancels the identity atomically before removing its unattached bytes.
 */
export async function createImportedDocument(
  input: Parameters<typeof createDocument>[0] & {
    importSource: NonNullable<Parameters<typeof createDocument>[0]['importSource']>;
  },
) {
  const documentId = dependencies.randomUUID();
  try {
    return await createDocument({ ...input, documentId });
  } catch (error) {
    let settlement: Awaited<ReturnType<typeof cancelDocumentImport>>;
    try {
      settlement = await cancelDocumentImport({
        userId: input.userId,
        documentId,
        storageId: input.importSource.storageId,
      });
    } catch (cleanupError) {
      console.error('[document-import] Could not confirm import cleanup', cleanupError);
      throw new DocumentImportUnconfirmedError();
    }
    if (settlement.status === 'attached') {
      if (settlement.document?.documentId === documentId) return settlement.document;
      throw new DocumentImportUnconfirmedError();
    }
    throw error;
  }
}

export interface DocumentImportSourceLink {
  format: 'xlsx';
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  warnings: string[];
  importedAt: number;
  revision: number;
  currentRevision: number;
  url: string;
}

export async function getDocumentImportSource(userId: string, documentId: string) {
  return dependencies.convexQuery<DocumentImportSourceLink | null>(documentsApi.getImportSource, {
    userId,
    documentId,
  });
}

export async function findDocumentByGoogleFile(input: {
  userId: string;
  connectionId: string;
  fileId: string;
}) {
  const row = await dependencies.convexQuery<AlbatrossDocumentRecord | null>(
    documentsApi.findByGoogleFile,
    input,
  );
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
  allowDowngrade?: boolean;
}) {
  const kind =
    input.model === undefined
      ? null
      : await dependencies.convexQuery<DocumentKind | null>(documentsApi.getKind, {
          userId: input.userId,
          documentId: input.documentId,
        });
  if (input.model !== undefined && !kind) return { ok: false as const, code: 'NOT_FOUND' as const };
  const model = input.model === undefined ? undefined : parseDocumentModel(input.model, kind!);
  if (model !== undefined) assertModelWithinLimit(model);
  return dependencies.convexMutation<
    | { ok: true; document: AlbatrossDocumentRecord }
    | {
        ok: false;
        code: 'NOT_FOUND' | 'REVISION_CONFLICT' | 'ENGINE_MODEL_REQUIRED';
        document?: AlbatrossDocumentRecord;
      }
  >(documentsApi.update, {
    userId: input.userId,
    documentId: input.documentId,
    expectedRevision: input.expectedRevision,
    title: input.title === undefined ? undefined : input.title.trim().slice(0, 500) || 'Untitled',
    model,
    sourceRefs: input.sourceRefs,
    reason: input.reason,
    actor: input.actor,
    allowDowngrade: input.allowDowngrade,
  });
}

export async function archiveDocument(userId: string, documentId: string) {
  return dependencies.convexMutation<{ ok: boolean }>(documentsApi.archive, { userId, documentId });
}

export interface DocumentRevision {
  revision: number;
  title: string;
  model: AlbatrossDocumentModel;
  reason: string;
  actor: 'user' | 'ai' | 'system';
  createdAt: number;
}

export async function listDocumentRevisions(userId: string, documentId: string) {
  return dependencies.convexQuery<DocumentRevision[]>(documentsApi.listRevisions, {
    userId,
    documentId,
    limit: 100,
  });
}

export async function restoreDocumentRevision(input: {
  userId: string;
  documentId: string;
  revision: number;
  expectedRevision: number;
}) {
  return dependencies.convexMutation<{ ok: boolean; code?: string }>(documentsApi.restoreRevision, input);
}

export async function createDocumentSuggestion(input: {
  userId: string;
  documentId: string;
  title: string;
  description: string;
  proposedModel: SuggestionPayload;
  baseRevision?: number;
  sourceRefs?: DocumentSourceRef[];
}) {
  const suggestionId = dependencies.randomUUID();
  const result = await dependencies.convexMutation<{ ok: boolean; createdAt?: number }>(
    documentsApi.createSuggestion,
    {
      ...input,
      suggestionId,
    },
  );
  return { ...result, suggestionId };
}

export async function resolveDocumentSuggestion(input: {
  userId: string;
  documentId: string;
  suggestionId: string;
  status: 'applied' | 'dismissed';
}) {
  return dependencies.convexMutation<{ ok: boolean; code?: 'ALREADY_RESOLVED' }>(
    documentsApi.resolveSuggestion,
    input,
  );
}

export async function applyDocumentSuggestion(input: {
  userId: string;
  documentId: string;
  suggestionId: string;
  expectedRevision: number;
  /** Engine snapshot after the editor applied a change-set suggestion. */
  model?: AlbatrossDocumentModel;
}) {
  if (input.model !== undefined) assertModelWithinLimit(input.model);
  return dependencies.convexMutation<
    | { ok: true; document: AlbatrossDocumentRecord }
    | {
        ok: false;
        code: 'NOT_FOUND' | 'ALREADY_RESOLVED' | 'REVISION_CONFLICT' | 'NEEDS_EDITOR';
        document?: AlbatrossDocumentRecord;
      }
  >(documentsApi.applySuggestion, input);
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
  return dependencies.convexMutation<{
    ok: boolean;
    code?: 'ALREADY_LINKED';
    documentId?: string;
    google?: AlbatrossDocumentRecord['google'];
  }>(documentsApi.linkGoogleFile, input);
}

export async function createAndLinkGoogleDocument(input: {
  userId: string;
  kind: DocumentKind;
  title: string;
  model: unknown;
  sourceRefs: DocumentSourceRef[];
  reason: string;
  connectionId: string;
  fileId: string;
  mimeType: string;
  webUrl?: string;
  providerVersion?: string;
}) {
  const document = await createDocument({
    userId: input.userId,
    kind: input.kind,
    title: input.title,
    model: input.model,
    sourceRefs: input.sourceRefs,
    reason: input.reason,
  });
  try {
    const linked = await linkGoogleDocument({
      userId: input.userId,
      documentId: document.documentId,
      connectionId: input.connectionId,
      fileId: input.fileId,
      mimeType: input.mimeType,
      webUrl: input.webUrl,
      providerVersion: input.providerVersion,
      syncedRevision: document.currentRevision,
    });
    if (!linked.ok) {
      await archiveOrphanedGoogleImport(input.userId, document.documentId);
    }
    return { document, linked };
  } catch (error) {
    await archiveOrphanedGoogleImport(input.userId, document.documentId);
    throw error;
  }
}

async function archiveOrphanedGoogleImport(userId: string, documentId: string) {
  try {
    const archived = await archiveDocument(userId, documentId);
    if (!archived.ok) {
      console.warn(
        '[google-file-import] failed to archive orphaned document',
        documentId,
        'archive returned ok:false',
      );
    }
  } catch (error) {
    console.warn('[google-file-import] failed to archive orphaned document', documentId, error);
  }
}

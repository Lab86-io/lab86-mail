import { z } from 'zod';
import { GOOGLE_NATIVE_MIME_TYPES, importGoogleNativeFile } from '@/lib/documents/google-import';
import { DOCUMENT_KINDS } from '@/lib/documents/model';
import {
  archiveDocument,
  createDocument,
  findDocumentByGoogleFile,
  linkGoogleDocument,
} from '@/lib/documents/service';
import { browseCloudFiles } from '@/lib/files/browse';
import { listCloudFileConnections } from '@/lib/files/connections';
import { defineTool } from './registry';

function requireUserId(userId: string | null | undefined) {
  if (!userId) throw new Error('Not authenticated.');
  return userId;
}

const nativeMimeSchema = z.enum(GOOGLE_NATIVE_MIME_TYPES);

const defaultDependencies = {
  archiveDocument,
  browseCloudFiles,
  createDocument,
  findDocumentByGoogleFile,
  importGoogleNativeFile,
  linkGoogleDocument,
  listCloudFileConnections,
};

let dependencies = defaultDependencies;

export function __setCloudFileToolDepsForTest(overrides: Partial<typeof defaultDependencies> = {}) {
  dependencies = { ...defaultDependencies, ...overrides };
}

export const cloudFileSearch = defineTool({
  name: 'cloud_file_search',
  description:
    'Search or list the user’s connected Google Drive and OneDrive files. Returns real provider ids, types, and open URLs. Use google_file_import on a returned Google Doc, Sheet, or Slides file before reading or editing its contents.',
  category: 'documents',
  mutating: false,
  input: z.object({
    query: z.string().max(200).default(''),
    connectionId: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    files: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        provider: z.string(),
        connectionId: z.string().optional(),
        mimeType: z.string().optional(),
        modifiedAt: z.number().optional(),
        webUrl: z.string().optional(),
        isFolder: z.boolean(),
      }),
    ),
    errors: z
      .array(
        z.object({
          connectionId: z.string(),
          error: z.string(),
        }),
      )
      .optional(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const connections = await dependencies.listCloudFileConnections(userId);
    const targets = args.connectionId
      ? connections.filter((connection) => connection.connectionId === args.connectionId)
      : connections;
    if (args.connectionId && !targets.length) throw new Error('File connection not found.');
    const settled = await Promise.allSettled(
      targets.map((connection) =>
        dependencies.browseCloudFiles({
          userId,
          connectionId: connection.connectionId,
          query: args.query || undefined,
        }),
      ),
    );
    const files = settled
      .flatMap((result) => (result.status === 'fulfilled' ? result.value.items : []))
      .slice(0, args.limit)
      .map((file) => ({
        id: file.id,
        name: file.name,
        provider: file.provider,
        connectionId: file.connectionId,
        mimeType: file.mimeType,
        modifiedAt: file.modifiedAt,
        webUrl: file.webUrl,
        isFolder: file.isFolder,
      }));
    const errors = settled.flatMap((result, index) =>
      result.status === 'rejected'
        ? [
            {
              connectionId: targets[index].connectionId,
              error:
                result.reason instanceof Error
                  ? result.reason.message.slice(0, 500)
                  : 'The file connection could not be searched.',
            },
          ]
        : [],
    );
    if (errors.length && errors.length === targets.length) {
      throw new Error(errors.map((failure) => failure.error).join(' '));
    }
    return { files, ...(errors.length ? { errors } : {}) };
  },
});

export const googleFileImport = defineTool({
  name: 'google_file_import',
  description:
    'Import a Google Doc, Sheet, or Slides file returned by cloud_file_search into the revisioned Albatross editor. Existing imports are reused. This does not publish or share the file.',
  category: 'documents',
  mutating: true,
  input: z.object({
    connectionId: z.string().min(1).max(500),
    fileId: z.string().min(1).max(500),
    mimeType: nativeMimeSchema,
    webUrl: z.string().url().max(2_000).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    documentId: z.string(),
    title: z.string(),
    kind: z.enum(DOCUMENT_KINDS),
    revision: z.number(),
    openPath: z.string(),
    existing: z.boolean(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const existing = await dependencies.findDocumentByGoogleFile({
      userId,
      connectionId: args.connectionId,
      fileId: args.fileId,
    });
    if (existing) {
      return {
        ok: true,
        documentId: existing.documentId,
        title: existing.title,
        kind: existing.kind,
        revision: existing.currentRevision,
        openPath: `/?view=files&document=${encodeURIComponent(existing.documentId)}`,
        existing: true,
      };
    }
    const imported = await dependencies.importGoogleNativeFile({
      userId,
      connectionId: args.connectionId,
      fileId: args.fileId,
      mimeType: args.mimeType,
    });
    const webUrl = imported.webUrl || args.webUrl;
    const document = await dependencies.createDocument({
      userId,
      kind: imported.kind,
      title: imported.title,
      model: imported.model,
      sourceRefs: [
        {
          kind: 'google_drive',
          id: args.fileId,
          label: imported.title,
          url: webUrl,
        },
      ],
      reason: 'google_import',
    });
    try {
      const linked = await dependencies.linkGoogleDocument({
        userId,
        documentId: document.documentId,
        connectionId: args.connectionId,
        fileId: args.fileId,
        mimeType: args.mimeType,
        webUrl,
        providerVersion: imported.providerVersion,
        syncedRevision: document.currentRevision,
      });
      if (!linked.ok) throw new Error('The imported Google file is already linked.');
    } catch (error) {
      await dependencies.archiveDocument(userId, document.documentId).catch(() => undefined);
      throw error;
    }
    return {
      ok: true,
      documentId: document.documentId,
      title: document.title,
      kind: document.kind,
      revision: document.currentRevision,
      openPath: `/?view=files&document=${encodeURIComponent(document.documentId)}`,
      existing: false,
    };
  },
});

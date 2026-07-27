import { z } from 'zod';
import { GOOGLE_NATIVE_MIME, importGoogleNativeFile } from '@/lib/documents/google-import';
import { createDocument, findDocumentByGoogleFile, linkGoogleDocument } from '@/lib/documents/service';
import { browseCloudFiles } from '@/lib/files/browse';
import { listCloudFileConnections } from '@/lib/files/connections';
import { defineTool } from './registry';

function requireUserId(userId: string | null | undefined) {
  if (!userId) throw new Error('Not authenticated.');
  return userId;
}

const nativeMimeSchema = z.enum([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
]);

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
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const connections = await listCloudFileConnections(userId);
    const targets = args.connectionId
      ? connections.filter((connection) => connection.connectionId === args.connectionId)
      : connections;
    if (args.connectionId && !targets.length) throw new Error('File connection not found.');
    const settled = await Promise.allSettled(
      targets.map((connection) =>
        browseCloudFiles({
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
    return { files };
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
    kind: z.enum(['doc', 'sheet', 'deck']),
    revision: z.number(),
    openPath: z.string(),
    existing: z.boolean(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const existing = await findDocumentByGoogleFile({
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
    const imported = await importGoogleNativeFile({
      userId,
      connectionId: args.connectionId,
      fileId: args.fileId,
      mimeType: args.mimeType,
    });
    const webUrl = imported.webUrl || args.webUrl;
    const document = await createDocument({
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
    await linkGoogleDocument({
      userId,
      documentId: document.documentId,
      connectionId: args.connectionId,
      fileId: args.fileId,
      mimeType: args.mimeType,
      webUrl,
      providerVersion: imported.providerVersion,
      syncedRevision: document.currentRevision,
    });
    return {
      ok: true,
      documentId: document.documentId,
      title: document.title,
      kind: GOOGLE_NATIVE_MIME[args.mimeType],
      revision: document.currentRevision,
      openPath: `/?view=files&document=${encodeURIComponent(document.documentId)}`,
      existing: false,
    };
  },
});

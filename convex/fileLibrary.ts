import { v } from 'convex/values';
import { query } from './_generated/server';
import { requireInternalSecret } from './lib';

/** Paginated metadata only: listing a library never transfers document models. */
export const page = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    kind: v.union(v.literal('documents'), v.literal('uploads')),
    cursor: v.optional(v.string()),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const options = {
      cursor: args.cursor || null,
      numItems: 50,
      maximumRowsRead: 50,
      maximumBytesRead: 2_000_000,
    };
    const terms = (args.search || '').trim().toLocaleLowerCase().slice(0, 200).split(/\s+/).filter(Boolean);
    const matches = (name: string) => terms.every((term) => name.toLocaleLowerCase().includes(term));
    if (args.kind === 'documents') {
      const result = await ctx.db
        .query('documents')
        .withIndex('by_user_updated', (q) => q.eq('userId', args.userId))
        .order('desc')
        .paginate(options);
      return {
        nextCursor: result.isDone ? null : result.continueCursor,
        items: result.page
          .filter((row) => !row.archivedAt && matches(row.title))
          .map((row) => ({
            id: row.documentId,
            documentId: row.documentId,
            documentKind: row.kind,
            name: row.title,
            provider: 'albatross' as const,
            mimeType: `application/x-albatross-${row.kind === 'doc' ? 'document' : row.kind === 'sheet' ? 'spreadsheet' : 'presentation'}`,
            modifiedAt: row.updatedAt,
            owner: 'Albatross',
            isFolder: false,
          })),
      };
    }
    const result = await ctx.db
      .query('agentUploads')
      .withIndex('by_user_created', (q) => q.eq('userId', args.userId))
      .order('desc')
      .paginate(options);
    const items = await Promise.all(
      result.page
        .filter((row) => matches(row.name))
        .map(async (row) => ({
          id: row._id,
          name: row.name,
          provider: 'albatross' as const,
          mimeType: row.contentType,
          size: row.size,
          modifiedAt: row.createdAt,
          webUrl: (await ctx.storage.getUrl(row.storageId)) || undefined,
          isFolder: false,
        })),
    );
    return { items, nextCursor: result.isDone ? null : result.continueCursor };
  },
});

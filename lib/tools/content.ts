import { z } from 'zod';
import { contentExcerpt, sourceLink } from '../content/contract';
import { searchContent } from '../content/intelligence';
import { defineTool } from './registry';

export function createContentSearch(search = searchContent) {
  return defineTool({
    name: 'content_search',
    description:
      'Search indexed content across connected drives, meeting notes, tickets, messages, Albatross documents and mail. Combines exact text and semantic retrieval. Returns actual source excerpts, version, modified time, and coverage flags. Cite the source and check partial content before drawing conclusions. An empty result does not prove a source has been fully indexed.',
    category: 'mcp',
    mutating: false,
    input: z.object({ query: z.string().min(2).max(200), semantic: z.boolean().default(true) }),
    output: z.object({ items: z.array(z.any()), semanticUnavailable: z.boolean() }),
    async handler({ query, semantic }, ctx) {
      if (!ctx.userId) throw new Error('Not authenticated.');
      const result = await search(ctx.userId, query, { semantic, signal: ctx.abortSignal });
      return {
        ...result,
        items: result.items.slice(0, 12).map((item) => ({
          id: item._id,
          title: item.title,
          source: item.source,
          url: sourceLink(item),
          version: item.version,
          modifiedAt: item.modifiedAt,
          partial: item.partial || item.text.length > 8000,
          content: contentExcerpt(item.text, query, 8000),
        })),
      };
    },
  });
}
export const contentSearch = createContentSearch();

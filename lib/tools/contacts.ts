import { z } from 'zod';
import { defineTool } from './registry';

export const contactLookup = defineTool({
  name: 'contact_lookup',
  description: 'Look up contacts matching a fuzzy name or email substring.',
  category: 'contacts',
  mutating: false,
  input: z.object({
    account: z.string(),
    query: z.string(),
    limit: z.number().int().min(1).max(20).default(8),
  }),
  output: z.object({ contacts: z.array(z.any()) }),
  async handler() {
    return { contacts: [] };
  },
});

export const expandAlias = defineTool({
  name: 'expand_alias',
  description: 'Resolve a short alias to a full email address using contacts.',
  category: 'contacts',
  mutating: false,
  input: z.object({ account: z.string(), alias: z.string() }),
  output: z.object({ email: z.string().nullable(), displayName: z.string().optional() }),
  async handler() {
    return { email: null };
  },
});

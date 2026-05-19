import { z } from 'zod';
import { defineTool } from './registry';
import { runGogJson } from '../gog/pool';

export const contactLookup = defineTool({
  name: 'contact_lookup',
  description: 'Look up contacts matching a fuzzy name or email substring.',
  category: 'contacts',
  mutating: false,
  input: z.object({ account: z.string(), query: z.string(), limit: z.number().int().min(1).max(20).default(8) }),
  output: z.object({ contacts: z.array(z.any()) }),
  async handler({ account, query, limit }) {
    const raw = await runGogJson<any>([
      '--account', account, '--json', 'people', 'search', query,
      '--limit', String(limit), '--no-input',
    ]).catch(() => null);
    return { contacts: raw?.people || raw?.contacts || raw?.results || [] };
  },
});

export const expandAlias = defineTool({
  name: 'expand_alias',
  description: 'Resolve a short alias ("alice") to a full email address using contacts.',
  category: 'contacts',
  mutating: false,
  input: z.object({ account: z.string(), alias: z.string() }),
  output: z.object({ email: z.string().nullable(), displayName: z.string().optional() }),
  async handler({ account, alias }) {
    const raw = await runGogJson<any>([
      '--account', account, '--json', 'people', 'search', alias,
      '--limit', '1', '--no-input',
    ]).catch(() => null);
    const top = raw?.people?.[0] || raw?.contacts?.[0] || raw?.results?.[0];
    const email = top?.emailAddresses?.[0]?.value || top?.email || null;
    return { email, displayName: top?.names?.[0]?.displayName || top?.displayName };
  },
});

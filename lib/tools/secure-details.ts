import { z } from 'zod';
import { type SecureInventoryEntry, secureInventory, secureStoreEnabled } from '../secure/store';
import { defineTool, type ToolContext } from './registry';

// Passwords and IDs for the model (docs/albatross-secure-store.md). The model
// learns what is saved (ids, labels, sites, field names) and never a value.
// It cannot save or read a value: it can only ask the user to add an item
// with ask_secure_detail (lib/ai/loop.ts), a card that opens the add sheet.

/** The store calls the tools make; tests replace them. */
export const secureDetailsToolDeps = {
  enabled: secureStoreEnabled,
  inventory: secureInventory,
};

function userIdOf(ctx: ToolContext) {
  if (!ctx.userId) throw new Error('Passwords and IDs need a signed-in user.');
  return ctx.userId;
}

const OFF_MESSAGE = 'Passwords and IDs is not available for this account.';

const InventoryRow = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  sites: z.array(z.string()),
  fields: z.array(z.string()),
  idType: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
  expired: z.boolean().optional(),
  ageYears: z.number().optional(),
  header: z.string().optional(),
});

export const secureDetailsList = defineTool({
  name: 'secure_details_list',
  description:
    "List the user's saved Passwords and IDs: sign-ins, ID numbers, date of birth, and API keys. You get each item's id, label, sites, and field names, never a value. A date of birth gives the age only. A step run types a value as a {{secure:<id>.<field>}} reference; in the chat you only tell the user what is saved. Never ask the user to type a password, an ID number, or a key in the chat.",
  category: 'memory',
  mutating: false,
  input: z.object({}).optional(),
  output: z.object({
    enabled: z.boolean(),
    items: z.array(InventoryRow),
    message: z.string().optional(),
  }),
  async handler(_args, ctx) {
    const userId = userIdOf(ctx);
    if (!secureDetailsToolDeps.enabled(userId)) return { enabled: false, items: [], message: OFF_MESSAGE };
    const items: SecureInventoryEntry[] = await secureDetailsToolDeps.inventory(userId);
    return { enabled: true, items };
  },
});

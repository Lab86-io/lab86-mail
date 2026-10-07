import { z } from 'zod';
import { phoneParts } from '../personal-details/format';
import { listPersonalDetails, missingDetailKeys, savePersonalDetails } from '../personal-details/store';
import { defineTool, type ToolContext } from './registry';

// The user's own personal details for forms (docs/albatross-thread.md). The
// model reads the values here, only on the turns that need them. It saves
// only what the user wrote or confirmed in this conversation.

/** The store calls the tools make; tests replace them. */
export const personalDetailsToolDeps = {
  list: listPersonalDetails,
  saveMany: savePersonalDetails,
};

function userOf(ctx: ToolContext) {
  if (!ctx.userId) throw new Error('Personal details need a signed-in user.');
  return { userId: ctx.userId, name: ctx.userName, email: ctx.userEmail };
}

const DetailRow = z.object({
  key: z.string(),
  label: z.string(),
  value: z.unknown(),
  display: z.string(),
  source: z.string(),
  confirmed: z.boolean(),
  phone: z
    .object({
      e164: z.string().nullable(),
      area: z.string().nullable(),
      prefix: z.string().nullable(),
      line: z.string().nullable(),
    })
    .optional(),
});

export const personalDetailsGet = defineTool({
  name: 'personal_details_get',
  description:
    "Read the user's saved personal details for a form: name, email, phone, home address, emergency contact, and custom facts. Call it before you fill a form or ask the user for a detail. confirmed:false means the value comes from the account and the user did not confirm it for forms. A phone has its parts for forms with three boxes. Never put these values in a message to another person unless the user asked.",
  category: 'memory',
  mutating: false,
  input: z.object({ keys: z.array(z.string().max(60)).max(12).optional() }).optional(),
  output: z.object({ details: z.array(DetailRow), missing: z.array(z.string()) }),
  async handler(args, ctx) {
    const all = await personalDetailsToolDeps.list(userOf(ctx));
    const wanted = args?.keys?.length ? new Set(args.keys) : null;
    const details = all
      .filter((entry) => !wanted || wanted.has(entry.key))
      .map((entry) => ({
        key: entry.key,
        label: entry.label,
        value: entry.value,
        display: entry.display,
        source: entry.source,
        confirmed: entry.saved,
        ...(entry.key === 'phone' && typeof entry.value === 'string'
          ? (() => {
              const parts = phoneParts(entry.value);
              return {
                phone: { e164: parts.e164, area: parts.area, prefix: parts.prefix, line: parts.line },
              };
            })()
          : {}),
      }));
    return { details, missing: missingDetailKeys(all) };
  },
});

export const personalDetailsSave = defineTool({
  name: 'personal_details_save',
  description:
    "Save personal details that the user wrote in this conversation or confirmed in a form: name ({first, middle?, last}), email, phone, home_address ({line1, line2?, city, region, postalCode, country ISO-2}), emergency_contact ({name, phone, relationship?}), or a custom fact (key 'custom' with a label, plain facts only). Never save a value you found in mail or on a page unless the user confirmed it. Passwords, codes, card numbers, bank numbers, and ID numbers are refused. The user sees a receipt with Undo.",
  category: 'memory',
  risk: 'write_self',
  mutating: true,
  input: z.object({
    details: z
      .array(
        z.object({
          key: z.string().min(1).max(60),
          value: z.unknown(),
          label: z.string().max(60).optional(),
        }),
      )
      .min(1)
      .max(8),
  }),
  output: z.object({
    ok: z.boolean(),
    saved: z.array(z.object({ key: z.string(), label: z.string(), display: z.string() })),
    rejected: z.array(z.object({ key: z.string(), message: z.string() })),
    message: z.string().optional(),
  }),
  async handler(args, ctx) {
    const result = await personalDetailsToolDeps.saveMany(userOf(ctx), args.details, 'chat');
    return {
      ok: result.saved.length > 0,
      saved: result.saved.map((entry) => ({ key: entry.key, label: entry.label, display: entry.display })),
      rejected: result.rejected.map((entry) => ({ key: entry.key, message: entry.message })),
      ...(result.saved.length
        ? {}
        : { message: result.rejected.map((entry) => entry.message).join(' ') || 'Nothing was saved.' }),
    };
  },
});

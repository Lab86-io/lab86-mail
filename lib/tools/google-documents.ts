import { z } from 'zod';
import { GOOGLE_NATIVE_MIME_TYPES, importGoogleNativeFile } from '@/lib/documents/google-import';
import { googleModelWriteLimitation } from '@/lib/documents/google-write-policy';
import { parseDocumentModel } from '@/lib/documents/model';
import { defineTool } from './registry';

const identity = z.object({
  connectionId: z.string().min(1).max(500),
  fileId: z.string().min(1).max(500),
  mimeType: z.enum(GOOGLE_NATIVE_MIME_TYPES),
});
const defaults = { read: importGoogleNativeFile };
let deps = defaults;
export function __setGoogleDocumentToolDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
}
function owner(userId?: string | null) {
  if (!userId) throw new Error('Not authenticated.');
  return userId;
}

export const googleDocumentGet = defineTool({
  name: 'google_document_get',
  category: 'documents',
  mutating: false,
  description:
    'Read the original Google Doc, Sheet, or Slides file open in the editor, including its model and providerVersion. Does not create an Albatross copy. Respect editability; use google_document_edit to propose changes for review.',
  input: identity,
  output: z.object({
    title: z.string(),
    kind: z.enum(['doc', 'sheet', 'deck']),
    model: z.unknown(),
    providerVersion: z.string().optional(),
    editability: z.object({ editable: z.boolean(), reason: z.string().optional() }).optional(),
  }),
  async handler(args, ctx) {
    return deps.read({ ...args, userId: owner(ctx.userId) });
  },
});

export const googleDocumentEdit = defineTool({
  name: 'google_document_edit',
  category: 'documents',
  mutating: false,
  description:
    'Propose a complete revised model for the original Google file using the shape and providerVersion from google_document_get. Never writes to Google: the user reviews and applies the proposal in the open editor. Preserve existing content outside the requested edits. Do not propose while the editor has unsaved changes.',
  input: identity.extend({
    expectedProviderVersion: z.string().min(1).max(100),
    title: z.string().min(1).max(500),
    model: z.unknown(),
    summary: z.string().min(1).max(1000),
  }),
  output: identity.extend({
    ok: z.boolean(),
    status: z.literal('proposed'),
    suggestionId: z.string(),
    openPath: z.string(),
    title: z.string(),
    kind: z.enum(['doc', 'sheet', 'deck']),
    model: z.unknown(),
    expectedProviderVersion: z.string(),
    summary: z.string(),
  }),
  async handler(args, ctx) {
    const current = await deps.read({ ...args, userId: owner(ctx.userId) });
    if (!current.providerVersion || current.providerVersion !== args.expectedProviderVersion)
      throw new Error('This file changed in Google Drive. Read it again before proposing edits.');
    if (current.editability?.editable === false)
      throw new Error(current.editability.reason || 'This file is read-only.');
    const model = parseDocumentModel(args.model, current.kind);
    const limitation = googleModelWriteLimitation(model);
    if (limitation) throw new Error(limitation);
    return {
      ...args,
      model,
      kind: current.kind,
      ok: true,
      status: 'proposed' as const,
      suggestionId: crypto.randomUUID(),
      openPath: `/?${new URLSearchParams({ view: 'files', provider: 'google_drive', connection: args.connectionId, file: args.fileId, mime: args.mimeType })}`,
    };
  },
});

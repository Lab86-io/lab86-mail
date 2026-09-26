import { z } from 'zod';
import { wordEditsSchema } from '@/lib/documents/word-package';
import { wordDocuments } from '@/lib/documents/word-service';
import { defineTool } from './registry';

function owner(userId?: string | null) {
  if (!userId) throw new Error('Not authenticated.');
  return userId;
}
export const wordDocumentCreate = defineTool({
  name: 'word_document_create',
  category: 'documents',
  risk: 'write_self',
  mutating: true,
  description:
    'Create a full Word DOCX document that opens in the integrated word processor with pages, tables, images, headers, footers, comments and review tools. Supply ordered edits to create real content and styling. Optionally copy an existing lightweight Albatross document using sourceDocumentId and its expectedRevision; the source is retained. Never publishes or shares.',
  input: z.object({
    title: z.string().min(1).max(500),
    edits: wordEditsSchema.optional(),
    sourceDocumentId: z.string().min(1).optional(),
    expectedRevision: z.number().int().min(1).optional(),
  }),
  output: z.object({
    ok: z.literal(true),
    documentId: z.string(),
    title: z.string(),
    revision: z.number(),
    openPath: z.string(),
  }),
  handler: async (input, ctx) => wordDocuments.create(owner(ctx.userId), input),
});
export const wordDocumentGet = defineTool({
  name: 'word_document_get',
  category: 'documents',
  mutating: false,
  description:
    'Read the saved DOCX revision, paragraph indexes and text, plus table, image and section counts. Use the returned revision and zero-based paragraph indexes for word_document_edit. This reads saved content, not unsaved typing in an open word processor.',
  input: z.object({ documentId: z.string().min(1) }),
  output: z.object({
    ok: z.literal(true),
    documentId: z.string(),
    title: z.string(),
    revision: z.number(),
    paragraphs: z.array(
      z.object({ index: z.number(), text: z.string(), style: z.string().nullable(), inTable: z.boolean() }),
    ),
    tables: z.number(),
    images: z.number(),
    notes: z.array(z.object({ part: z.string(), text: z.string() })),
    sections: z.number(),
    openPath: z.string(),
  }),
  handler: async (input, ctx) => wordDocuments.read(owner(ctx.userId), input.documentId),
});
export const wordDocumentEdit = defineTool({
  name: 'word_document_edit',
  category: 'documents',
  risk: 'write_self',
  mutating: true,
  description:
    'Edit a saved Word DOCX as an immutable revision: insert paragraphs/headings, tables and PNG/JPEG images; add comments; set headers/footers; replace text across formatted runs; change font/size/color/highlight, paragraph alignment/spacing/page breaks, and page size/orientation/margins. Unrelated package content is preserved. Read word_document_get first. Paragraph indexes are zero-based and apply to the document after each preceding operation. Omitted after appends to the body. format_text formats entire selected paragraphs; page_setup affects the final section. An open connected Collabora editor is automatically saved, paused, and reopened. If autosaving changes the revision, read word_document_get again before retrying; never reuse stale paragraph indexes. Unresponsive editors and concurrent changes fail safely. All edits succeed together or none are saved.',
  input: z.object({
    documentId: z.string().min(1),
    expectedRevision: z.number().int().min(1),
    edits: wordEditsSchema,
  }),
  output: z.object({
    ok: z.literal(true),
    title: z.string(),
    documentId: z.string(),
    revision: z.number(),
    openPath: z.string(),
  }),
  handler: async (input, ctx) =>
    wordDocuments.edit(owner(ctx.userId), input.documentId, input.expectedRevision, input.edits),
});

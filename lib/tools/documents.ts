import { z } from 'zod';
import { recordOperation, registerUndoExecutor } from '@/lib/ai/operations';
import { generateDocumentProposal } from '@/lib/documents/ai';
import { documentEditsSchema, prepareDocumentEdits } from '@/lib/documents/edits';
import { publishDocumentToGoogle } from '@/lib/documents/google';
import { DOCUMENT_KINDS, documentModelText, isSheetWorkbookModel } from '@/lib/documents/model';
import {
  archiveDocument,
  createDocument,
  createDocumentSuggestion,
  getDocument,
  listDocuments,
  updateDocument,
} from '@/lib/documents/service';
import { spreadsheetCapabilities, spreadsheetCommandNames } from '@/lib/documents/spreadsheet-commands';
import { applySpreadsheetChanges } from '@/lib/documents/spreadsheet-server';
import { defineTool } from './registry';

function requireUserId(userId: string | null | undefined) {
  if (!userId) throw new Error('Not authenticated.');
  return userId;
}

const sourceRefSchema = z.object({
  kind: z.string().min(1).max(80),
  id: z.string().min(1).max(500),
  label: z.string().max(500).optional(),
  accountId: z.string().max(500).optional(),
  url: z.string().max(2_000).optional(),
});

const defaultDependencies = {
  applySpreadsheetChanges,
  archiveDocument,
  createDocument,
  createDocumentSuggestion,
  generateDocumentProposal,
  getDocument,
  listDocuments,
  publishDocumentToGoogle,
  recordOperation,
  updateDocument,
};

let dependencies = defaultDependencies;

export function __setDocumentToolDepsForTest(overrides: Partial<typeof defaultDependencies> = {}) {
  dependencies = { ...defaultDependencies, ...overrides };
}

export const documentCreate = defineTool({
  name: 'document_create',
  description:
    'Create an editable Albatross document, spreadsheet, or presentation. Use instructions and sourceContext to generate real content; the result opens from Files and can be exported or published to Google. This creates a private draft, never sends or shares it.',
  category: 'documents',
  mutating: true,
  input: z.object({
    kind: z.enum(DOCUMENT_KINDS),
    title: z.string().min(1).max(500),
    instructions: z.string().min(1).max(20_000).optional(),
    sourceContext: z.string().max(40_000).optional(),
    sourceRefs: z.array(sourceRefSchema).max(100).optional(),
    publishToGoogle: z.boolean().default(false),
    googleConnectionId: z.string().max(500).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    documentId: z.string(),
    title: z.string(),
    kind: z.enum(DOCUMENT_KINDS),
    revision: z.number(),
    openPath: z.string(),
    googleUrl: z.string().optional(),
    publishError: z.string().optional(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const proposal = args.instructions
      ? await dependencies.generateDocumentProposal({
          userId,
          userEmail: ctx.userEmail || undefined,
          userName: ctx.userName || undefined,
          kind: args.kind,
          instruction: args.instructions,
          sourceContext: args.sourceContext,
        })
      : null;
    const document = await dependencies.createDocument({
      userId,
      kind: args.kind,
      title: args.title || proposal?.title,
      model: proposal?.model,
      sourceRefs: args.sourceRefs,
      reason: proposal?.summary || 'agent_create',
    });
    await dependencies.recordOperation({
      userId,
      tool: 'document_create',
      surface: 'albatross',
      summary: `Created ${args.kind} “${document.title}”`,
      target: { kind: 'document', id: document.documentId },
      inverse: { kind: 'documents.archive', payload: { documentId: document.documentId } },
    });
    let google: Awaited<ReturnType<typeof publishDocumentToGoogle>> | null = null;
    let publishError: string | undefined;
    if (args.publishToGoogle) {
      try {
        google = await dependencies.publishDocumentToGoogle({
          userId,
          document,
          connectionId: args.googleConnectionId,
        });
      } catch (error) {
        publishError =
          error instanceof Error
            ? error.message.slice(0, 500)
            : 'Google publish failed after the Albatross document was created.';
      }
    }
    return {
      ok: true,
      documentId: document.documentId,
      title: document.title,
      kind: document.kind,
      revision: document.currentRevision,
      openPath: `/?view=files&document=${encodeURIComponent(document.documentId)}`,
      googleUrl: google?.webUrl,
      publishError,
    };
  },
});

export const documentList = defineTool({
  name: 'document_list',
  description: 'List the user’s editable Albatross documents, spreadsheets, and presentations.',
  category: 'documents',
  mutating: false,
  input: z.object({
    kind: z.enum(DOCUMENT_KINDS).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    documents: z.array(
      z.object({
        documentId: z.string(),
        title: z.string(),
        kind: z.enum(DOCUMENT_KINDS),
        revision: z.number(),
        updatedAt: z.number(),
        googleUrl: z.string().optional(),
      }),
    ),
  }),
  async handler(args, ctx) {
    const documents = await dependencies.listDocuments({
      userId: requireUserId(ctx.userId),
      kind: args.kind,
      limit: args.limit,
    });
    return {
      documents: documents.map((document) => ({
        documentId: document.documentId,
        title: document.title,
        kind: document.kind,
        revision: document.currentRevision,
        updatedAt: document.updatedAt,
        googleUrl: document.google?.webUrl,
      })),
    };
  },
});

export const documentGet = defineTool({
  name: 'document_get',
  description:
    'Read one Albatross file, including its canonical model, plain-text projection, revision, sources, and pending AI suggestions.',
  category: 'documents',
  mutating: false,
  input: z.object({ documentId: z.string().min(1) }),
  output: z.object({
    document: z.any(),
    text: z.string(),
  }),
  async handler(args, ctx) {
    const document = await dependencies.getDocument(requireUserId(ctx.userId), args.documentId);
    if (!document) throw new Error('Document not found.');
    return { document, text: documentModelText(document.model) };
  },
});

export const spreadsheetCapabilitiesTool = defineTool({
  name: 'spreadsheet_capabilities',
  description:
    'Discover the full Odoo spreadsheet editing suite: charts/graphs, styled tables, pivots, formatting, borders, conditional formats, validation, images, merges, filters, sorting, autofill, sheets, rows and columns. Call without commands for the catalog, then request command names for exact JSON schemas before using document_edit spreadsheet_command operations.',
  category: 'documents',
  mutating: false,
  input: z.object({ commands: z.array(z.enum(spreadsheetCommandNames)).max(20).default([]) }),
  output: z.any(),
  async handler(args) {
    return spreadsheetCapabilities(args.commands);
  },
});

export const documentSuggestChanges = defineTool({
  name: 'document_suggest_changes',
  description:
    'Create a reviewable AI suggestion for an existing Albatross file. It appears in the editor’s suggestion rail and does not change the file until the user applies it.',
  category: 'documents',
  mutating: true,
  input: z.object({
    documentId: z.string().min(1),
    instruction: z.string().min(1).max(20_000),
    sourceContext: z.string().max(40_000).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    suggestionId: z.string(),
    title: z.string(),
    description: z.string(),
    openPath: z.string(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const document = await dependencies.getDocument(userId, args.documentId);
    if (!document) throw new Error('Document not found.');
    // The revision the proposal is grounded in is fixed BEFORE generation so a
    // user typing during the model call makes this suggestion stale instead of
    // letting it overwrite their newer work when applied.
    const baseRevision = document.currentRevision;
    const proposal = await dependencies.generateDocumentProposal({
      userId,
      userEmail: ctx.userEmail || undefined,
      userName: ctx.userName || undefined,
      kind: document.kind,
      instruction: args.instruction,
      current: document,
      sourceContext: args.sourceContext,
    });
    const suggestion = await dependencies.createDocumentSuggestion({
      userId,
      documentId: document.documentId,
      title: proposal.title,
      description: proposal.summary,
      proposedModel: proposal.model,
      baseRevision,
      sourceRefs: document.sourceRefs,
    });
    if (!suggestion.ok) throw new Error('The suggestion could not be saved. No edits were applied.');
    return {
      ok: true,
      suggestionId: suggestion.suggestionId,
      title: proposal.title,
      description: proposal.summary,
      openPath: `/?view=files&document=${encodeURIComponent(document.documentId)}`,
    };
  },
});

export const documentApplyInstruction = defineTool({
  name: 'document_apply_instruction',
  description:
    'Apply an explicitly requested AI edit to an existing Albatross file as a new immutable revision. Use document_suggest_changes when the user asked to review first.',
  category: 'documents',
  mutating: true,
  input: z.object({
    documentId: z.string().min(1),
    instruction: z.string().min(1).max(20_000),
    sourceContext: z.string().max(40_000).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    documentId: z.string(),
    title: z.string(),
    revision: z.number(),
    summary: z.string(),
    openPath: z.string(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const document = await dependencies.getDocument(userId, args.documentId);
    if (!document) throw new Error('Document not found.');
    const baseRevision = document.currentRevision;
    const proposal = await dependencies.generateDocumentProposal({
      userId,
      userEmail: ctx.userEmail || undefined,
      userName: ctx.userName || undefined,
      kind: document.kind,
      instruction: args.instruction,
      current: document,
      sourceContext: args.sourceContext,
    });
    const model =
      proposal.model.kind === 'sheet-changes'
        ? await dependencies.applySpreadsheetChanges(document.model, proposal.model)
        : proposal.model;
    const result = await dependencies.updateDocument({
      userId,
      documentId: document.documentId,
      expectedRevision: baseRevision,
      title: proposal.title,
      model,
      reason: proposal.summary,
      actor: 'ai',
    });
    if (!result.ok) throw new Error('The file changed while Albatross was editing it. Try again.');
    return {
      ok: true,
      documentId: document.documentId,
      title: result.document.title,
      revision: result.document.currentRevision,
      summary: proposal.summary,
      openPath: `/?view=files&document=${encodeURIComponent(document.documentId)}`,
    };
  },
});

export const documentPublishGoogle = defineTool({
  name: 'document_publish_google',
  description:
    'Publish an Albatross document as a native Google Doc, Sheet, or Slides file, or sync a later revision. Engine-backed Odoo workbooks cannot be published or synced this way because that would discard formatting and workbook features; use the spreadsheet editor’s Excel download instead.',
  category: 'documents',
  mutating: true,
  input: z.object({
    documentId: z.string().min(1),
    connectionId: z.string().max(500).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    fileId: z.string(),
    webUrl: z.string().optional(),
    syncedRevision: z.number(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const document = await dependencies.getDocument(userId, args.documentId);
    if (!document) throw new Error('Document not found.');
    const google = await dependencies.publishDocumentToGoogle({
      userId,
      document,
      connectionId: args.connectionId,
    });
    return { ok: true, fileId: google.fileId, webUrl: google.webUrl, syncedRevision: google.syncedRevision };
  },
});

export const documentExport = defineTool({
  name: 'document_export',
  description:
    'Return the authenticated download URL for a file in DOCX, XLSX, or PPTX. Odoo workbook server downloads are values/formulas projections, not full-fidelity exports; use the editor download for the engine export.',
  category: 'documents',
  mutating: false,
  input: z.object({ documentId: z.string().min(1) }),
  output: z.object({
    ok: z.boolean(),
    downloadPath: z.string(),
    fidelity: z.enum(['full', 'projection']),
    warning: z.string().optional(),
    openPath: z.string(),
  }),
  async handler(args, ctx) {
    const document = await dependencies.getDocument(requireUserId(ctx.userId), args.documentId);
    if (!document) throw new Error('Document not found.');
    const engine = isSheetWorkbookModel(document.model);
    return {
      ok: true,
      downloadPath: `/api/documents/${encodeURIComponent(document.documentId)}/export`,
      fidelity: engine ? ('projection' as const) : ('full' as const),
      warning: engine
        ? 'This server download carries values and formulas only. Open the spreadsheet and use Download Excel to export through Odoo with its supported workbook features.'
        : undefined,
      openPath: `/?view=files&document=${encodeURIComponent(document.documentId)}`,
    };
  },
});

export const documentEdit = defineTool({
  name: 'document_edit',
  description:
    'Precisely edit document blocks, presentation slides/elements, or the full Odoo spreadsheet workbook using IDs and revision from document_get. Use spreadsheet_capabilities to read exact command payloads, then spreadsheet_command operations for real charts/graphs, styled tables, pivots, formatting, validation, images, and all workbook features; cell_update is also supported. No second AI generation is needed. Review mode creates a proposal; apply saves explicitly requested edits directly through the Odoo engine. Edits are atomic and cannot overwrite a newer revision. Files stay private; this does not publish, share, or send them.',
  category: 'documents',
  mutating: true,
  input: z.object({
    documentId: z.string().min(1).max(200),
    expectedRevision: z.number().int().min(1),
    mode: z.enum(['review', 'apply']).default('review'),
    summary: z.string().min(1).max(500),
    operations: documentEditsSchema,
  }),
  output: z.object({
    ok: z.boolean(),
    status: z.enum(['applied', 'proposed', 'conflict']),
    documentId: z.string(),
    title: z.string(),
    kind: z.enum(DOCUMENT_KINDS),
    revision: z.number(),
    suggestionId: z.string().optional(),
    summary: z.string(),
    openPath: z.string(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const document = await dependencies.getDocument(userId, args.documentId);
    if (!document) throw new Error('Document not found.');
    const result = {
      documentId: document.documentId,
      title: document.title,
      kind: document.kind,
      revision: document.currentRevision,
      openPath: `/?view=files&document=${encodeURIComponent(document.documentId)}`,
    };
    if (document.currentRevision !== args.expectedRevision)
      return {
        ...result,
        ok: false,
        status: 'conflict' as const,
        summary: 'Nothing changed. Read the latest file and review your edits against its new revision.',
      };
    const proposedModel = prepareDocumentEdits(document.model, args.operations);
    if (args.mode !== 'apply') {
      const suggestion = await dependencies.createDocumentSuggestion({
        userId,
        documentId: document.documentId,
        title: document.title,
        description: args.summary,
        proposedModel,
        baseRevision: args.expectedRevision,
        sourceRefs: document.sourceRefs,
      });
      if (!suggestion.ok) throw new Error('The suggestion could not be saved. No edits were applied.');
      return {
        ...result,
        ok: true,
        status: 'proposed' as const,
        suggestionId: suggestion.suggestionId,
        summary:
          proposedModel.kind === 'sheet-changes'
            ? `Not yet applied. Review these workbook changes in the spreadsheet editor: ${args.summary}`
            : `Not yet applied. A reviewable suggestion is ready in Files: ${args.summary}`,
      };
    }
    const saved = await dependencies.updateDocument({
      userId,
      documentId: document.documentId,
      expectedRevision: args.expectedRevision,
      model:
        proposedModel.kind === 'sheet-changes'
          ? await dependencies.applySpreadsheetChanges(document.model, proposedModel)
          : proposedModel,
      reason: args.summary,
      actor: 'ai',
    });
    if (!saved.ok)
      return {
        ...result,
        ok: false,
        status: 'conflict' as const,
        summary: 'Nothing changed. The file changed before these edits could be saved; read it again.',
      };
    return {
      ...result,
      revision: saved.document.currentRevision,
      ok: true,
      status: 'applied' as const,
      summary: args.summary,
    };
  },
});

registerUndoExecutor('documents.archive', async (payload, ctx) => {
  if (!payload?.documentId) throw new Error('Document undo target is missing.');
  await dependencies.archiveDocument(ctx.userId, String(payload.documentId));
});

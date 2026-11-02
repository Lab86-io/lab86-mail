import { z } from 'zod';
import { recordOperation, registerUndoExecutor } from '@/lib/ai/operations';
import { composeDocumentPresentation, generateDocumentProposal } from '@/lib/documents/ai';
import { artworksForDeck } from '@/lib/documents/deck-imagery';
import { checkSlide } from '@/lib/documents/deck-quality';
import { assetsFromUploads, MAX_UPLOAD_ASSETS } from '@/lib/documents/deck-upload-assets';
import { upgradeDeckModel } from '@/lib/documents/deck-versions';
import {
  deckVisualReportSchema,
  reviewDeckVisuals,
  visualReviewSummary,
} from '@/lib/documents/deck-visual-review';
import { type DocumentEditContext, documentEditsSchema, prepareDocumentEdits } from '@/lib/documents/edits';
import { exportDocument } from '@/lib/documents/export';
import { publishDocumentToGoogle } from '@/lib/documents/google';
import {
  createDefaultDocumentModel,
  DOCUMENT_KINDS,
  type DocumentKind,
  documentModelText,
  isSheetWorkbookModel,
  MAX_DOC_LIST_LEVEL,
} from '@/lib/documents/model';
import { saveDocxBytesAsPdf, saveOfficePdf } from '@/lib/documents/office-pdf';
import { OfficeError } from '@/lib/documents/office-security';
import {
  presentationAuthoringSchema,
  presentationAuthoringV2Schema,
  presentationSlideCountMatches,
} from '@/lib/documents/presentation-design';
import {
  archiveDocument,
  createDocument,
  createDocumentSuggestion,
  getDocument,
  listDocumentSummaries,
  updateDocument,
} from '@/lib/documents/service';
import { MAX_SHEET_CHANGES, sheetChangeSchema } from '@/lib/documents/sheet-workbook';
import { spreadsheetCapabilities, spreadsheetCommandNames } from '@/lib/documents/spreadsheet-commands';
import { applySpreadsheetChanges } from '@/lib/documents/spreadsheet-server';
import { truncateText } from '@/lib/shared/text';
import { defineTool, type ToolContext } from './registry';

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
  artworksForDeck,
  assetsFromUploads,
  createDocument,
  createDocumentSuggestion,
  composeDocumentPresentation,
  exportDocument,
  generateDocumentProposal,
  getDocument,
  listDocumentSummaries,
  publishDocumentToGoogle,
  recordOperation,
  reviewDeckVisuals,
  saveDocxBytesAsPdf,
  saveOfficePdf,
  updateDocument,
};

let dependencies = defaultDependencies;

export function __setDocumentToolDepsForTest(overrides: Partial<typeof defaultDependencies> = {}) {
  dependencies = { ...defaultDependencies, ...overrides };
}

const documentBlockInputSchema = z.object({
  type: z.enum(['paragraph', 'heading', 'bullet', 'numbered', 'quote']),
  text: z.string().max(100_000),
  level: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .optional()
    .describe('Heading level.'),
  listLevel: z
    .number()
    .int()
    .min(0)
    .max(MAX_DOC_LIST_LEVEL)
    .optional()
    .describe('List nesting. 0 is the top.'),
});

const documentSheetInputSchema = z.object({
  newSheets: z.array(z.string().min(1).max(200)).max(20).optional().describe('Names of more sheets to add.'),
  changes: z
    .array(sheetChangeSchema)
    .max(MAX_SHEET_CHANGES)
    .min(1)
    .describe('Cell values. sheet is "Sheet 1" or a name in newSheets. A formula starts with "=".'),
});

/** The fields of document_create that both the agent and a stored plan step can send. */
const documentCreateFields = {
  kind: z.enum(DOCUMENT_KINDS),
  title: z.string().min(1).max(500),
  blocks: z
    .array(documentBlockInputSchema)
    .min(1)
    .max(5_000)
    .optional()
    .describe('kind=doc: the finished text of the document, in order.'),
  sheet: documentSheetInputSchema.optional().describe('kind=sheet: the finished cells of the workbook.'),
  sourceContext: z
    .string()
    .max(40_000)
    .optional()
    .describe('kind=deck: the evidence that the slide review reads.'),
  sourceRefs: z.array(sourceRefSchema).max(100).optional(),
  publishToGoogle: z.boolean().default(false),
  googleConnectionId: z.string().max(500).optional(),
  imageUploadIds: z.array(z.string().min(1).max(200)).max(MAX_UPLOAD_ASSETS).optional(),
  artwork: z.enum(['auto', 'none']).optional(),
};

const PRESENTATION_FIELD_COPY =
  'kind=deck: the finished slides. The server reviews each slide, repairs copy and layout, and composes the deck. Put source detail and citations in speaker notes.';

/**
 * The schema the agent sees for document_create. It has no instructions field,
 * because the agent writes the content. It offers the one deck brief that the
 * renderer of this user takes (docs/albatross-goal-runs.md).
 */
export function documentCreateModelInput(deckV2: boolean) {
  return z.object({
    ...documentCreateFields,
    presentation: (deckV2 ? presentationAuthoringV2Schema : presentationAuthoringSchema)
      .optional()
      .describe(PRESENTATION_FIELD_COPY),
  });
}

const presentationInputSchema = z.union([presentationAuthoringV2Schema, presentationAuthoringSchema]);

const WRITE_IT_YOURSELF =
  'document_create does not write the content. Write it yourself and send it: blocks for kind=doc, sheet for kind=sheet, presentation for kind=deck. For an invoice, a letter, a memo, or a report, use word_document_create with template and data.';

type DocumentCreateArgs = {
  kind: DocumentKind;
  title: string;
  instructions?: string;
  blocks?: z.infer<typeof documentCreateFields.blocks>;
  sheet?: z.infer<typeof documentCreateFields.sheet>;
  sourceContext?: string;
  sourceRefs?: z.infer<typeof documentCreateFields.sourceRefs>;
  presentation?: z.infer<typeof presentationInputSchema>;
  publishToGoogle?: boolean;
  googleConnectionId?: string;
  imageUploadIds?: string[];
  artwork?: 'auto' | 'none';
};

function checkDocumentContent(args: DocumentCreateArgs, ctx: z.RefinementCtx) {
  const wrongKind = (path: string, kind: DocumentKind) =>
    ctx.addIssue({ code: 'custom', path: [path], message: `${path} content requires kind=${kind}.` });
  if (args.presentation && args.kind !== 'deck') wrongKind('presentation', 'deck');
  if (args.blocks && args.kind !== 'doc') wrongKind('blocks', 'doc');
  if (args.sheet && args.kind !== 'sheet') wrongKind('sheet', 'sheet');
  if (
    args.presentation &&
    args.instructions &&
    !presentationSlideCountMatches(args.instructions, args.presentation.slides.length)
  )
    ctx.addIssue({
      code: 'custom',
      path: ['presentation', 'slides'],
      message: 'Slide count does not match the instructions.',
    });
}

/** The server's file for the model-written content, or null for a blank file. */
async function contentModel(args: DocumentCreateArgs) {
  if (args.blocks)
    return {
      kind: 'doc' as const,
      version: 1 as const,
      blocks: args.blocks.map((block, index) => ({ id: `block-${index + 1}`, ...block })),
    };
  if (args.sheet)
    return dependencies.applySpreadsheetChanges(createDefaultDocumentModel('sheet'), {
      kind: 'sheet-changes',
      version: 1,
      changes: args.sheet.changes,
      ...(args.sheet.newSheets ? { newSheets: args.sheet.newSheets } : {}),
    });
  return null;
}

async function createDocumentFile(args: DocumentCreateArgs, ctx: ToolContext) {
  const userId = requireUserId(ctx.userId);
  ctx.abortSignal?.throwIfAborted();
  const notes: string[] = [];
  let assets: Awaited<ReturnType<typeof assetsFromUploads>>['assets'] | undefined;
  if (args.imageUploadIds?.length) {
    if (args.kind === 'deck') {
      const uploads = await dependencies.assetsFromUploads(userId, args.imageUploadIds);
      assets = uploads.assets;
      notes.push(...uploads.notes);
    } else notes.push('Image uploads apply to presentations only and were not used.');
  }
  ctx.abortSignal?.throwIfAborted();
  const proposal = args.presentation
    ? await dependencies.composeDocumentPresentation({
        userId,
        instruction: args.instructions || '',
        sourceContext: args.sourceContext,
        userEmail: ctx.userEmail || undefined,
        userName: ctx.userName || undefined,
        presentation: args.presentation,
        assets,
        artwork: args.artwork,
        abortSignal: ctx.abortSignal,
      })
    : args.instructions
      ? await dependencies
          .generateDocumentProposal({
            userId,
            userEmail: ctx.userEmail || undefined,
            userName: ctx.userName || undefined,
            kind: args.kind,
            instruction: args.instructions,
            sourceContext: args.sourceContext,
            abortSignal: ctx.abortSignal,
            ...(assets ? { assets } : {}),
            ...(args.artwork ? { artwork: args.artwork } : {}),
          })
          .catch(unreadableProposal)
      : null;
  const written = proposal ? null : await contentModel(args);
  ctx.abortSignal?.throwIfAborted();
  if (args.kind === 'deck' && proposal?.summary) notes.push(proposal.summary);
  const document = await dependencies.createDocument({
    userId,
    kind: args.kind,
    title: args.title || proposal?.title,
    model: proposal?.model ?? written ?? undefined,
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
      if (proposal?.visualReview?.status === 'needs_review')
        throw new Error('Draft saved. Finish its visual review before publishing to Google.');
      ctx.abortSignal?.throwIfAborted();
      google = await dependencies.publishDocumentToGoogle({
        userId,
        document,
        connectionId: args.googleConnectionId,
      });
    } catch (error) {
      publishError =
        error instanceof Error
          ? truncateText(error.message, 500)
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
    ...(proposal?.visualReview ? { visualReview: proposal.visualReview } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

const documentCreateOutput = z.object({
  ok: z.boolean(),
  documentId: z.string(),
  title: z.string(),
  kind: z.enum(DOCUMENT_KINDS),
  revision: z.number(),
  openPath: z.string(),
  googleUrl: z.string().optional(),
  publishError: z.string().optional(),
  visualReview: deckVisualReportSchema.optional(),
  /** Plain notes on uploads that were skipped. */
  notes: z.array(z.string()).optional(),
});

const DOCUMENT_CREATE_COPY =
  'Create an editable Albatross document, spreadsheet, or presentation from content that you wrote. It makes a private draft, and it does not send or share it. kind=doc: send blocks. kind=sheet: send sheet, then add charts and pivots with document_edit. kind=deck: send presentation with the finished slides. Call presentation_plan with your evidence first and do its calculation and visual steps. imageUploadIds supplies up to eight chat images. artwork auto adds credited public-domain paintings to open image slots of a version 2 brief; artwork none leaves them out. For an invoice, a letter, a memo, or a report, use word_document_create instead. Send no content for a blank file.';

export const documentCreate = defineTool({
  name: 'document_create',
  description: DOCUMENT_CREATE_COPY,
  category: 'documents',
  risk: 'write_self',
  mutating: true,
  input: z
    .object({
      ...documentCreateFields,
      // Not in the schema that the agent sees. A model that still sends it gets the rule.
      instructions: z.string().min(1).max(20_000).optional(),
      presentation: presentationInputSchema.optional().describe(PRESENTATION_FIELD_COPY),
    })
    .superRefine((args, ctx) => {
      checkDocumentContent(args, ctx);
      if (args.instructions && !args.presentation)
        ctx.addIssue({ code: 'custom', path: ['instructions'], message: WRITE_IT_YOURSELF });
    }),
  output: documentCreateOutput,
  handler: createDocumentFile,
});

/**
 * The one caller that needs a second model: a stored plan step has only its
 * instructions (lib/tools/albatross.ts). The agent cannot reach this tool.
 */
export const documentCreateFromInstructions = defineTool({
  name: 'document_create',
  description: 'Create an Albatross file from the instructions of a stored plan step.',
  category: 'documents',
  risk: 'write_self',
  mutating: true,
  input: z.object({
    kind: documentCreateFields.kind,
    title: documentCreateFields.title,
    instructions: z.string().min(1).max(20_000),
    sourceContext: documentCreateFields.sourceContext,
    sourceRefs: documentCreateFields.sourceRefs,
    publishToGoogle: documentCreateFields.publishToGoogle,
    googleConnectionId: documentCreateFields.googleConnectionId,
  }),
  output: documentCreateOutput,
  handler: createDocumentFile,
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
    const documents = await dependencies.listDocumentSummaries({
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
  risk: 'write_self',
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
      abortSignal: ctx.abortSignal,
    });
    ctx.abortSignal?.throwIfAborted();
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
  risk: 'write_self',
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
      abortSignal: ctx.abortSignal,
    });
    const model =
      proposal.model.kind === 'sheet-changes'
        ? await dependencies.applySpreadsheetChanges(document.model, proposal.model)
        : proposal.model;
    ctx.abortSignal?.throwIfAborted();
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

export const documentReviewSlides = defineTool({
  name: 'document_review_slides',
  description:
    'Render and visually inspect every slide of an existing presentation using the selected vision model. Repair layout, contrast and orientation without changing content or chart data, then inspect the repaired slides again. Use after document_edit or to resume a saved draft whose visualReview status is needs_review. Saves repairs with revision conflict protection; never recreates the presentation.',
  category: 'documents',
  risk: 'write_self',
  mutating: true,
  input: z.object({ documentId: z.string().min(1) }),
  output: z.object({
    ok: z.boolean(),
    documentId: z.string(),
    revision: z.number(),
    visualReview: deckVisualReportSchema,
    summary: z.string(),
    openPath: z.string(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    ctx.abortSignal?.throwIfAborted();
    const document = await dependencies.getDocument(userId, args.documentId);
    if (!document || document.model.kind !== 'deck') throw new Error('Presentation not found.');
    const reviewed = await dependencies.reviewDeckVisuals(upgradeDeckModel(document.model), {
      userId,
      abortSignal: ctx.abortSignal,
    });
    ctx.abortSignal?.throwIfAborted();
    const summary = visualReviewSummary(reviewed.report).trim();
    const saved = await dependencies.updateDocument({
      userId,
      documentId: document.documentId,
      expectedRevision: document.currentRevision,
      model: reviewed.model,
      reason: summary,
      actor: 'ai',
    });
    if (!saved.ok)
      throw new Error(
        'The presentation changed during visual review. Read the latest revision and review it again.',
      );
    return {
      ok: true,
      documentId: document.documentId,
      revision: saved.document.currentRevision,
      visualReview: reviewed.report,
      summary,
      openPath: `/?view=files&document=${encodeURIComponent(document.documentId)}`,
    };
  },
});

export const documentPublishGoogle = defineTool({
  name: 'document_publish_google',
  description:
    'Publish an Albatross document as a native Google Doc, Sheet, or Slides file, or sync a later revision. Engine-backed Odoo workbooks cannot be published or synced this way because that would discard formatting and workbook features; use the spreadsheet editor’s Excel download instead.',
  category: 'documents',
  risk: 'write_self',
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

/** The words the model sees when the reply that writes the document cannot be read. */
export const UNREADABLE_PROPOSAL_COPY =
  'The model that writes the document sent a reply that could not be read. Do not send the same request again. For an invoice, a letter, a memo, or a report, use word_document_create with a template (enable documents_more). Otherwise make the instructions shorter.';

/** A provider reply that is not JSON (the AI SDK says "Invalid JSON response") gets plain words. */
function unreadableProposal(error: unknown): never {
  if (error instanceof Error && error.message === 'Invalid JSON response')
    throw new Error(UNREADABLE_PROPOSAL_COPY, { cause: error });
  throw error;
}

/** A Word file converts as saved; a text document converts from its DOCX export. */
async function exportPdf(userId: string, documentId: string) {
  let saved: Awaited<ReturnType<typeof saveOfficePdf>>;
  try {
    saved = await dependencies.saveOfficePdf(userId, documentId);
  } catch (error) {
    if (!(error instanceof OfficeError) || error.status !== 404) throw error;
    const document = await dependencies.getDocument(userId, documentId);
    if (!document) throw new Error('Document not found.');
    if (document.kind !== 'doc')
      throw new Error('PDF export works for Word files and text documents. Use the native format.');
    const exported = await dependencies.exportDocument(document);
    saved = await dependencies.saveDocxBytesAsPdf(userId, exported.bytes, document.title);
  }
  return {
    ok: true as const,
    format: 'pdf' as const,
    documentId,
    fileId: saved.fileId,
    title: saved.title,
    openPath: saved.openPath,
    size: saved.size,
    contentType: saved.contentType,
    sha256: saved.sha256,
  };
}

export const documentExport = defineTool({
  name: 'document_export',
  description:
    'Return the authenticated download URL for a file in DOCX, XLSX, or PPTX. Odoo workbook server downloads are values/formulas projections, not full-fidelity exports; use the editor download for the engine export. With format pdf, the document server makes a PDF of a Word file (from word_document_create) or of a text document, and the PDF is saved in Files: the result fileId can go on a draft as an attachment or into the package. The PDF shows the saved revision; fill the blanks first.',
  category: 'documents',
  // The pdf format saves a file in Files. Checkpointing keeps a retry from saving it twice.
  risk: 'write_self',
  mutating: true,
  input: z.object({
    documentId: z.string().min(1),
    format: z
      .enum(['native', 'pdf'])
      .optional()
      .describe('native (the default): a DOCX, XLSX, or PPTX download link. pdf: a saved PDF file.'),
  }),
  output: z.union([
    z.object({
      ok: z.boolean(),
      downloadPath: z.string(),
      fidelity: z.enum(['full', 'projection']),
      warning: z.string().optional(),
      openPath: z.string(),
    }),
    z.object({
      ok: z.literal(true),
      format: z.literal('pdf'),
      documentId: z.string(),
      fileId: z.string(),
      title: z.string(),
      openPath: z.string(),
      size: z.number(),
      contentType: z.string(),
      sha256: z.string(),
    }),
  ]),
  async handler(args, ctx) {
    if (args.format === 'pdf') return exportPdf(requireUserId(ctx.userId), args.documentId);
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
    'Precisely edit document blocks, presentation slides/elements, or the full Odoo spreadsheet workbook using IDs and revision from document_get. For a presentation, deck_restyle changes the look without touching content: palette (editorial, signal, grove, lagoon, dusk, rose, sand, slate, or six custom hex colors), fontPair (serif, sans, literary, humanist, grotesk, mono), scope theme (colors and fonts) or theme-and-layout (every slide recomposed through the compositions; facts, chart data, notes, slide order and locked elements stay), and imagery paintings (credited public-domain paintings on the cover, statement, image, quote and close slides that have no image) or none (paintings removed; the user’s own images stay). When the user explicitly asks to restyle, retheme or change the look, send deck_restyle with mode apply so it saves directly. Element coordinates are percentages 0–100, width/height at least 1. Use spreadsheet_capabilities to read exact command payloads, then spreadsheet_command operations for real charts/graphs, styled tables, pivots, formatting, validation, images, and all workbook features; cell_update is also supported. No second AI generation is needed. Review mode creates a proposal; apply saves explicitly requested edits directly through the Odoo engine. Edits are atomic and cannot overwrite a newer revision. Files stay private; this does not publish, share, or send them.',
  category: 'documents',
  risk: 'write_self',
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
    const context: DocumentEditContext = {};
    let artworkNote = '';
    const wantsPaintings =
      document.kind === 'deck' &&
      document.model.kind === 'deck' &&
      args.operations.some(
        (operation) => operation.op === 'deck_restyle' && operation.imagery === 'paintings',
      );
    if (wantsPaintings && document.model.kind === 'deck') {
      try {
        const art = await dependencies.artworksForDeck(document.model, { userId });
        context.artworks = art.artworks;
        context.imageryTheme = art.imagery;
        if (!Object.keys(art.artworks).length) artworkNote = ' No artwork was available for these slides.';
      } catch {
        artworkNote = ' Artwork could not be added; the slides stay typographic.';
      }
    }
    const proposedModel = prepareDocumentEdits(document.model, args.operations, context);
    if (proposedModel.kind === 'deck') {
      const inserted = new Set(
        args.operations.flatMap((operation) => (operation.op === 'slide_insert' ? [operation.slide.id] : [])),
      );
      const deck = upgradeDeckModel(proposedModel);
      const blank = deck.slides.filter(
        (slide) =>
          inserted.has(slide.id) &&
          checkSlide(slide, deck.theme).some((issue) => issue.kind === 'empty-slide'),
      );
      if (blank.length)
        throw new Error(
          `Slides ${blank.map((slide) => slide.id).join(', ')} have no visible content. slide_insert requires visible elements; title and notes are metadata. Add text, image, or chart elements in the same edit. Nothing was saved.`,
        );
    }
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
            : `Not yet applied. A reviewable suggestion is ready in Files: ${args.summary}${artworkNote}`,
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
      summary: `${args.summary}${artworkNote}`,
    };
  },
});

registerUndoExecutor('documents.archive', async (payload, ctx) => {
  if (!payload?.documentId) throw new Error('Document undo target is missing.');
  await dependencies.archiveDocument(ctx.userId, String(payload.documentId));
});

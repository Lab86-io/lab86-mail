import { z } from 'zod';
import { recordOperation, registerUndoExecutor } from '@/lib/ai/operations';
import { composeDocumentPresentation, generateDocumentProposal } from '@/lib/documents/ai';
import { artworksForDeck } from '@/lib/documents/deck-imagery';
import { checkSlide } from '@/lib/documents/deck-quality';
import { assetsFromUploads, MAX_UPLOAD_ASSETS } from '@/lib/documents/deck-upload-assets';
import { upgradeDeckModel } from '@/lib/documents/deck-versions';
import { type DocumentEditContext, documentEditsSchema, prepareDocumentEdits } from '@/lib/documents/edits';
import { publishDocumentToGoogle } from '@/lib/documents/google';
import { DOCUMENT_KINDS, documentModelText, isSheetWorkbookModel } from '@/lib/documents/model';
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
  artworksForDeck,
  assetsFromUploads,
  createDocument,
  createDocumentSuggestion,
  composeDocumentPresentation,
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
    'Create an editable Albatross document, spreadsheet, or presentation. For researched decks, provide presentation with the finished slide content: it composes through review of every slide and bounded copy/layout repair. Prefer the version 2 brief with audience, purpose, tone, palette (editorial or signal), fontPair (serif or sans), imagery and slide roles: cover, statement, image-left, image-right, metrics, chart, table, process, comparison, list, quote, close. Chart slides take typed categories/series; table slides take headers/rows/source and compose editable cells. Call presentation_plan with gathered evidence first, execute its calculation and visual tool steps, then create the deck. Legacy briefs remain supported. imageUploadIds supplies up to eight owned chat images; artwork auto fills open version 2 image slots with credited public-domain paintings, while artwork none keeps slides typographic. Use instructions and sourceContext when content still needs generating. Omit both to create a blank file. The result opens from Files and can be exported or published to Google. This creates a private draft, never sends or shares it.',
  category: 'documents',
  mutating: true,
  input: z
    .object({
      kind: z.enum(DOCUMENT_KINDS),
      title: z.string().min(1).max(500),
      instructions: z.string().min(1).max(20_000).optional(),
      sourceContext: z.string().max(40_000).optional(),
      sourceRefs: z.array(sourceRefSchema).max(100).optional(),
      presentation: z
        .union([presentationAuthoringV2Schema, presentationAuthoringSchema])
        .optional()
        .describe(
          'Finished presentation content for kind=deck; reviewed slide by slide, repaired and composed before saving. Put source detail and citations in speaker notes.',
        ),
      publishToGoogle: z.boolean().default(false),
      googleConnectionId: z.string().max(500).optional(),
      imageUploadIds: z.array(z.string().min(1).max(200)).max(MAX_UPLOAD_ASSETS).optional(),
      artwork: z.enum(['auto', 'none']).optional(),
    })
    .superRefine((args, ctx) => {
      if (args.presentation && args.kind !== 'deck')
        ctx.addIssue({
          code: 'custom',
          path: ['presentation'],
          message: 'Presentation content requires kind=deck.',
        });
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
    /** Plain notes on uploads that were skipped. */
    notes: z.array(z.string()).optional(),
  }),
  async handler(args, ctx) {
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
        ? await dependencies.generateDocumentProposal({
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
        : null;
    ctx.abortSignal?.throwIfAborted();
    if (args.kind === 'deck' && proposal?.summary) notes.push(proposal.summary);
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
        ctx.abortSignal?.throwIfAborted();
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
      ...(notes.length ? { notes } : {}),
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
    'Precisely edit document blocks, presentation slides/elements, or the full Odoo spreadsheet workbook using IDs and revision from document_get. For a presentation, deck_restyle changes the look without touching content: palette (editorial, signal, or six custom hex colors), fontPair (serif or sans), scope theme (colors and fonts) or theme-and-layout (every slide recomposed through the compositions; facts, chart data, notes, slide order and locked elements stay), and imagery paintings (credited public-domain paintings on the cover, statement, image, quote and close slides that have no image) or none (paintings removed; the user’s own images stay). When the user explicitly asks to restyle, retheme or change the look, send deck_restyle with mode apply so it saves directly. Element coordinates are percentages 0–100, width/height at least 1. Use spreadsheet_capabilities to read exact command payloads, then spreadsheet_command operations for real charts/graphs, styled tables, pivots, formatting, validation, images, and all workbook features; cell_update is also supported. No second AI generation is needed. Review mode creates a proposal; apply saves explicitly requested edits directly through the Odoo engine. Edits are atomic and cannot overwrite a newer revision. Files stay private; this does not publish, share, or send them.',
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

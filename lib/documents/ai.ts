import { z } from 'zod';
import { generateObjectForCurrentUser } from '@/lib/ai/gateway';
import { withToolTimeout } from '@/lib/ai/tool-timeout';
import { envFlag } from '@/lib/hosted/controls';
import {
  artworksBySlideIndex,
  artworksForDeck,
  imageryTheme,
  planDeckImagery,
  resolveDeckImagery,
} from './deck-imagery';
import { type DeckIssue, repairDeck } from './deck-quality';
import { availableRenderBrowser, renderDeckSlides } from './deck-render';
import { deckModelsEqual } from './deck-versions';
import { isDeckV2AuthoringEnabled } from './editor-flags';
import { type DocumentEditContext, prepareDocumentEdits } from './edits';
import {
  type AlbatrossDocumentModel,
  type AlbatrossDocumentRecord,
  createDefaultDocumentModel,
  type DeckModelV2,
  type DocumentKind,
  deckModelSchema,
  deckModelV2Schema,
  docModelSchema,
  documentKindLabel,
  isSheetWorkbookModel,
  type SheetChangeSet,
  sheetModelSchema,
} from './model';
import { buildDeckTheme, type CompositionArtwork, type CompositionAsset } from './presentation-compositions';
import {
  briefFieldForElement,
  composePresentation,
  composePresentationV2,
  copyRepairSchema,
  mentionsRestyle,
  PRESENTATION_DESIGN_GUIDANCE,
  PRESENTATION_DESIGN_GUIDANCE_V2,
  type PresentationBrief,
  type PresentationBriefV2,
  presentationAuthoringSchema,
  presentationAuthoringV2Schema,
  presentationSlideCountMatches,
  RESTYLE_CLASSIFIER_GUIDANCE,
  restyleClassificationSchema,
  restyleOperationFor,
} from './presentation-design';
import {
  copyFields,
  fitSlideCopy,
  preservesNumericClaims,
  replaceSlideCopy,
  reviewPresentation,
} from './presentation-review';
import { MAX_SHEET_CHANGES, sheetChangeSchema, workbookText } from './sheet-workbook';
import {
  spreadsheetCapabilities,
  spreadsheetCommandNames,
  spreadsheetCommandSchema,
  validateSpreadsheetCommand,
} from './spreadsheet-commands';
import { applySpreadsheetChanges } from './spreadsheet-server';

const defaultDependencies = {
  generateObjectForCurrentUser,
  availableRenderBrowser,
  renderDeckSlides,
  isDeckV2AuthoringEnabled,
  resolveDeckImagery,
  artworksForDeck,
};

let dependencies = defaultDependencies;

export function __setDocumentAiDepsForTest(overrides: Partial<typeof defaultDependencies> = {}) {
  dependencies = { ...defaultDependencies, ...overrides };
}

export class DocumentGenerationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DocumentGenerationError';
  }
}

const schemas = {
  doc: docModelSchema,
  sheet: sheetModelSchema,
  deck: deckModelSchema,
} as const;

/** The deck schema an existing deck is edited through: version 2 stays version 2. */
function deckModelSchemaFor(current?: AlbatrossDocumentModel) {
  return current?.kind === 'deck' && current.version === 2 ? deckModelV2Schema : deckModelSchema;
}

function modelSchemaFor(kind: DocumentKind, current?: AlbatrossDocumentModel) {
  return kind === 'deck' ? deckModelSchemaFor(current) : schemas[kind];
}

function outputSchema(kind: DocumentKind, current?: AlbatrossDocumentModel) {
  return z.object({
    title: z.string().min(1).max(500),
    summary: z.string().min(1).max(1_000),
    model: modelSchemaFor(kind, current),
  });
}

const sheetChangesOutputSchema = z
  .object({
    title: z.string().min(1).max(500),
    summary: z.string().min(1).max(1_000),
    changes: z.array(sheetChangeSchema).max(MAX_SHEET_CHANGES),
    newSheets: z.array(z.string().min(1).max(200)).max(20).optional(),
    commands: z.array(spreadsheetCommandSchema).max(MAX_SHEET_CHANGES).optional(),
  })
  .refine((value) => value.changes.length + (value.commands?.length || 0) > 0);

export interface DocumentProposal {
  title: string;
  summary: string;
  model: AlbatrossDocumentModel | SheetChangeSet;
}

function modelGuidance(kind: 'doc' | 'deck', current?: AlbatrossDocumentModel) {
  if (kind === 'doc') {
    return `Create structured blocks. Use heading blocks for hierarchy, paragraphs for prose, bullet or numbered blocks for lists, and quote only for attributed/source language. Keep block ids short and unique.`;
  }
  if (current?.kind === 'deck' && current.version === 2)
    return `Edit the presentation as 16:9 slides on the version 2 model. Every element uses percentage coordinates from 0 to 100. Keep the deck theme, the element names and the image asset ids; use theme colors for new elements. Keep concise slide titles, readable body text, a clear visual hierarchy, speaker notes when useful, and short unique ids.`;
  return `Create a presentation as 16:9 slides. Every element uses percentage coordinates from 0 to 100. Use concise slide titles, readable body text, a clear visual hierarchy, speaker notes when useful, and short unique ids.`;
}

/**
 * Workbooks are edited through Odoo commands instead of regenerated wholesale.
 * The same versioned engine evaluates cell, style, chart, table, and other
 * commands before a full snapshot is saved as a new revision.
 */
async function generateSheetChangeSet(input: {
  userId: string;
  userEmail?: string;
  userName?: string;
  instruction: string;
  current: AlbatrossDocumentRecord;
  sourceContext?: string;
  abortSignal?: AbortSignal;
}): Promise<DocumentProposal> {
  input.abortSignal?.throwIfAborted();
  if (input.current.model.kind !== 'sheet') throw new Error('Expected a workbook.');
  const sources = input.sourceContext?.trim()
    ? `\nGrounding material:\n${input.sourceContext.trim().slice(0, 40_000)}`
    : '';
  const { object } = await dependencies.generateObjectForCurrentUser<
    z.infer<typeof sheetChangesOutputSchema>
  >({
    userId: input.userId,
    userEmail: input.userEmail,
    userName: input.userName,
    feature: 'document_suggestion',
    abortSignal: input.abortSignal,
    speed: 'primary',
    maxOutputTokens: 14_000,
    schema: sheetChangesOutputSchema,
    system: `You are Albatross's spreadsheet assistant. Use the full Odoo workbook suite: real charts/graphs, styled tables, pivots, formatting, borders, conditional formats, validation, merges, sorting, and sheet structure. Return cell changes and/or commands using the exact JSON schemas below. For cell changes give the sheet ID or exact name, A1 reference, and content; Formulas start with "=". Put names of new sheets in newSheets, or CREATE_SHEET with an explicit ID before commands targeting it. Cell changes run before commands; use UPDATE_CELL commands when operation ordering matters. Use real CREATE_CHART figures for charts, never text bars. REPT is NOT a supported Odoo function. Never invent data that is not in the workbook or grounding material. Preserve all unrelated workbook features. Return a concise title and summary.\nCommand contracts:\n${JSON.stringify(spreadsheetCapabilities(spreadsheetCommandNames))}`,
    prompt: `Current spreadsheet "${input.current.title}":\n${(isSheetWorkbookModel(input.current.model) ? workbookText(input.current.model) : JSON.stringify(input.current.model)).slice(0, 120_000)}\nWorkbook structure and existing features:\n${JSON.stringify(isSheetWorkbookModel(input.current.model) ? { ...input.current.model.workbook, sheets: input.current.model.workbook.sheets.map(({ cells: _cells, ...sheet }) => sheet) } : input.current.model).slice(0, 60_000)}${sources}\n\nUser instruction:\n${input.instruction.trim().slice(0, 20_000)}`,
  });
  let parsed: z.infer<typeof sheetChangesOutputSchema>;
  try {
    parsed = sheetChangesOutputSchema.parse(object);
    parsed.commands?.forEach(validateSpreadsheetCommand);
  } catch (error) {
    throw new DocumentGenerationError('The spreadsheet model returned invalid workbook changes.', {
      cause: error,
    });
  }
  return {
    title: parsed.title,
    summary: parsed.summary,
    model: {
      kind: 'sheet-changes',
      version: 1,
      changes: parsed.changes,
      newSheets: parsed.newSheets,
      ...(parsed.commands ? { commands: parsed.commands } : {}),
    },
  };
}

interface DeckGenerationInput {
  userId: string;
  userEmail?: string;
  userName?: string;
  instruction: string;
  sourceContext?: string;
  /** Owned assets the deck may show. Never external links. */
  assets?: CompositionAsset[];
  /** auto: credited public-domain paintings fill the open image slots. none: typographic slides. */
  artwork?: 'auto' | 'none';
  abortSignal?: AbortSignal;
}

/** Paintings for a new deck, with the note the summary carries. Failures degrade to typography. */
interface DeckArtworkSelection {
  artworks?: Partial<Record<number, CompositionArtwork>>;
  imagery?: ReturnType<typeof imageryTheme>;
  note: string;
}

async function selectDeckArtworks(
  input: DeckGenerationInput,
  brief: PresentationBriefV2,
): Promise<DeckArtworkSelection> {
  input.abortSignal?.throwIfAborted();
  if (input.artwork === 'none') return { note: '' };
  const plan = planDeckImagery(brief, buildDeckTheme(brief.palette, brief.fontPair), {
    assets: input.assets,
  });
  if (!plan.slots.length) return { note: '' };
  try {
    const resolved = await dependencies.resolveDeckImagery(plan, { userId: input.userId });
    input.abortSignal?.throwIfAborted();
    const artworks = artworksBySlideIndex(plan, resolved);
    const count = Object.keys(artworks).length;
    if (!count) return { note: ' Artwork was not available; the slides are typographic.' };
    return {
      artworks,
      imagery: imageryTheme(plan),
      note: ` Added ${count} public-domain ${count === 1 ? 'painting' : 'paintings'} with credits.`,
    };
  } catch {
    return { note: ' Artwork could not be added; the slides are typographic.' };
  }
}

const COPY_REPAIR_GUIDANCE = `Some slide copy does not fit its box. Return shorter text for each listed field. Keep the meaning. Keep every number, name and date exactly as written. Do not add, remove or reorder slides. Plain language, no emoji. Fields: title, kicker, body, notes, chart.source, items.N.label, items.N.detail, items.N.meta.`;

function issueList(issues: DeckIssue[]) {
  return issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => `${issue.slideId}: ${issue.message}`)
    .join(' ');
}

/**
 * Quality loop: review every slide, compose, repair with bounded model calls,
 * preserve overflow in notes and check again. A deck
 * that still fails is never returned. The render check runs only when a
 * browser is available and DECK_RENDER_CHECK is set; its failure is a note in
 * the summary, not a failure of the generation.
 */
async function finishComposedDeck(
  input: DeckGenerationInput,
  initial: PresentationBriefV2,
  art: DeckArtworkSelection = { note: '' },
): Promise<{ brief: PresentationBriefV2; model: DeckModelV2; summary: string }> {
  input.abortSignal?.throwIfAborted();
  const reviewed = await reviewPresentation(initial, input, dependencies.generateObjectForCurrentUser);
  const brief = reviewed.brief;
  const slideIds = brief.slides.map((_, index) => `slide-${index + 1}`);
  const compose = () =>
    repairDeck(
      composePresentationV2(brief, {
        assets: input.assets,
        slideIds,
        ...(art.artworks ? { artworks: art.artworks } : {}),
        ...(art.imagery ? { imagery: art.imagery } : {}),
      }),
    );
  let repaired = compose();
  for (let attempt = 0; attempt < 2 && !repaired.report.ok; attempt++) {
    const targets: { slideId: string; field: string; text: string; problem: string }[] = [];
    for (const issue of repaired.report.issues) {
      if (issue.severity !== 'error') continue;
      const slide = repaired.model.slides.find((candidate) => candidate.id === issue.slideId);
      for (const elementId of issue.elementIds) {
        const element = slide?.elements.find((candidate) => candidate.id === elementId);
        const field = element ? briefFieldForElement(element) : null;
        if (element?.type === 'text' && field)
          targets.push({ slideId: issue.slideId, field, text: element.text, problem: issue.message });
      }
    }
    if (targets.length) {
      try {
        const { object } = await withToolTimeout(
          (signal) =>
            dependencies.generateObjectForCurrentUser<z.infer<typeof copyRepairSchema>>({
              userId: input.userId,
              userEmail: input.userEmail,
              userName: input.userName,
              feature: 'document_generation',
              abortSignal: signal,
              speed: 'primary',
              maxOutputTokens: 4_000,
              schema: copyRepairSchema,
              system: COPY_REPAIR_GUIDANCE,
              prompt: JSON.stringify(targets),
            }),
          'presentation_copy_repair',
          { timeoutMs: 20_000, signal: input.abortSignal },
        );
        const fixes = copyRepairSchema.safeParse(object);
        if (fixes.success) {
          for (const fix of fixes.data.fixes) {
            const slide = brief.slides[slideIds.indexOf(fix.slideId)];
            const field = slide && copyFields(slide, true).find((field) => field.field === fix.field);
            if (slide && field && preservesNumericClaims(field.text, fix.text))
              replaceSlideCopy(slide, fix.field, fix.text);
          }
          for (const slide of brief.slides) fitSlideCopy(slide);
          repaired = compose();
        }
      } catch {
        input.abortSignal?.throwIfAborted();
      }
    }
  }
  // If a critique service fails or copy still overflows, progressively extract
  // readable visible copy, retaining every original field in speaker notes.
  for (let pass = 0; pass < 4 && !repaired.report.ok; pass++) {
    const failing = new Set(
      repaired.report.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.slideId),
    );
    brief.slides.forEach((slide, index) => {
      if (failing.has(slideIds[index])) fitSlideCopy(slide, 0.65 ** (pass + 1));
    });
    repaired = compose();
  }
  if (!repaired.report.ok)
    throw new DocumentGenerationError(
      `The presentation did not pass its layout check: ${issueList(repaired.report.issues)} Nothing was saved.`,
    );
  input.abortSignal?.throwIfAborted();
  let summary = `${brief.summary}${art.note}${reviewed.summary}`;
  if (envFlag('DECK_RENDER_CHECK')) {
    const browser = dependencies.availableRenderBrowser();
    if (browser) {
      try {
        const rendered = await dependencies.renderDeckSlides(repaired.model, {
          browser,
          ...(process.env.NEXT_PUBLIC_APP_URL ? { assetOrigin: process.env.NEXT_PUBLIC_APP_URL } : {}),
        });
        summary = `${summary} (rendered: ${rendered.length})`;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        summary = `${summary} (render check did not complete: ${message.slice(0, 200)})`;
      }
    }
  }
  return { brief, model: repaired.model, summary };
}

/** Review every page, repair copy and layout, then compose the researched content. */
export async function composeDocumentPresentation(
  input: DeckGenerationInput & { presentation: PresentationBrief | PresentationBriefV2 },
): Promise<DocumentProposal> {
  input.abortSignal?.throwIfAborted();
  const brief = input.presentation;
  if (!('audience' in brief)) {
    const reviewed = await reviewPresentation(brief, input, dependencies.generateObjectForCurrentUser);
    return {
      title: brief.title,
      summary: brief.summary + reviewed.summary,
      model: composePresentation(reviewed.brief),
    };
  }
  if (!dependencies.isDeckV2AuthoringEnabled())
    throw new DocumentGenerationError(
      'Version 2 presentation authoring is disabled. Use the legacy presentation brief.',
    );
  const art = await selectDeckArtworks(input, brief);
  const finished = await finishComposedDeck(input, brief, art);
  input.abortSignal?.throwIfAborted();
  return { title: brief.title, summary: finished.summary, model: finished.model };
}

/** New deck: generate an evidence-grounded brief, review every page, then compose and repair. */
async function generateDeckV2(input: DeckGenerationInput): Promise<DocumentProposal> {
  const { object } = await dependencies.generateObjectForCurrentUser({
    userId: input.userId,
    userEmail: input.userEmail,
    userName: input.userName,
    feature: 'document_generation',
    abortSignal: input.abortSignal,
    speed: 'primary',
    maxOutputTokens: 14_000,
    schema: presentationAuthoringV2Schema,
    system: PRESENTATION_DESIGN_GUIDANCE_V2,
    prompt: `Create a new presentation.\nGrounding material:\n${input.sourceContext?.trim().slice(0, 40_000) || 'No sources supplied; do not invent personal activity.'}${
      input.assets?.length
        ? `\nOwned image assets (assetId: description):\n${input.assets.map((asset) => `${asset.assetId}: ${asset.alt || 'image'}`).join('\n')}`
        : ''
    }\nUser instruction:\n${input.instruction.trim().slice(0, 20_000)}`,
  });
  let brief: PresentationBriefV2;
  try {
    brief = presentationAuthoringV2Schema.parse(object);
  } catch (error) {
    throw new DocumentGenerationError('The presentation generator returned an incomplete design.', {
      cause: error,
    });
  }
  if (!presentationSlideCountMatches(input.instruction, brief.slides.length))
    throw new DocumentGenerationError(
      `The generator returned ${brief.slides.length} slides outside the requested count constraints. No incomplete deck was saved.`,
    );
  input.abortSignal?.throwIfAborted();
  const art = await selectDeckArtworks(input, brief);
  const finished = await finishComposedDeck(input, brief, art);
  return { title: finished.brief.title, summary: finished.summary, model: finished.model };
}

/**
 * A restyle of an existing deck: one classification call, then the deterministic
 * restyle operation. Returns null when the instruction is not a pure restyle.
 */
async function proposeDeckRestyle(input: {
  userId: string;
  userEmail?: string;
  userName?: string;
  instruction: string;
  current: AlbatrossDocumentRecord;
  abortSignal?: AbortSignal;
}): Promise<DocumentProposal | null> {
  if (input.current.model.kind !== 'deck') return null;
  const { object } = await dependencies.generateObjectForCurrentUser({
    userId: input.userId,
    userEmail: input.userEmail,
    userName: input.userName,
    feature: 'document_suggestion',
    abortSignal: input.abortSignal,
    speed: 'classify',
    maxOutputTokens: 1_000,
    schema: restyleClassificationSchema,
    system: RESTYLE_CLASSIFIER_GUIDANCE,
    prompt: `Presentation "${input.current.title}" with ${input.current.model.slides.length} slides.\nInstruction:\n${input.instruction.trim().slice(0, 4_000)}`,
  });
  const classification = restyleClassificationSchema.safeParse(object);
  if (!classification.success) return null;
  const operation = restyleOperationFor(classification.data);
  if (!operation) return null;
  const context: DocumentEditContext = {};
  let note = '';
  if (operation.imagery === 'paintings') {
    try {
      const art = await dependencies.artworksForDeck(input.current.model, { userId: input.userId });
      context.artworks = art.artworks;
      context.imageryTheme = art.imagery;
      if (!Object.keys(art.artworks).length) note = ' No artwork was available for these slides.';
    } catch {
      note = ' Artwork could not be added; the slides stay typographic.';
    }
  }
  const model = prepareDocumentEdits(input.current.model, [operation], context);
  if (model.kind !== 'deck') return null;
  if (deckModelsEqual(input.current.model, model))
    throw new DocumentGenerationError(
      note
        ? `Artwork was not available, so nothing was changed.`
        : 'The requested look matches the current one. Nothing was changed.',
    );
  return { title: input.current.title, summary: `${classification.data.summary}${note}`, model };
}

export async function generateDocumentProposal(input: {
  userId: string;
  userEmail?: string;
  userName?: string;
  kind: DocumentKind;
  instruction: string;
  current?: AlbatrossDocumentRecord;
  sourceContext?: string;
  /** Owned image assets a new presentation may use. */
  assets?: CompositionAsset[];
  /** auto (default): paintings fill the open image slots of a new presentation. none: typographic slides. */
  artwork?: 'auto' | 'none';
  abortSignal?: AbortSignal;
}): Promise<DocumentProposal> {
  input.abortSignal?.throwIfAborted();
  const blankDeck =
    input.current?.model.kind === 'deck' &&
    input.current.model.slides.every((slide) =>
      slide.elements.every((element) => element.type === 'text' && !element.text?.trim()),
    );
  const deckV2 = input.kind === 'deck' && dependencies.isDeckV2AuthoringEnabled();
  if (input.kind === 'deck' && (!input.current || blankDeck)) {
    if (deckV2) return generateDeckV2(input);
    const { object } = await dependencies.generateObjectForCurrentUser({
      userId: input.userId,
      feature: 'document_generation',
      abortSignal: input.abortSignal,
      speed: 'primary',
      maxOutputTokens: 14_000,
      schema: presentationAuthoringSchema,
      system: PRESENTATION_DESIGN_GUIDANCE,
      prompt: `Create a new presentation.\nGrounding material:\n${input.sourceContext?.trim().slice(0, 40_000) || 'No sources supplied; do not invent personal activity.'}\nUser instruction:\n${input.instruction.trim().slice(0, 20_000)}`,
    });
    try {
      const brief = presentationAuthoringSchema.parse(object);
      if (!presentationSlideCountMatches(input.instruction, brief.slides.length))
        throw new DocumentGenerationError(
          `The generator returned ${brief.slides.length} slides outside the requested count constraints. No incomplete deck was saved.`,
        );
      return composeDocumentPresentation({ ...input, presentation: brief });
    } catch (error) {
      throw new DocumentGenerationError('The presentation generator returned an incomplete design.', {
        cause: error,
      });
    }
  }
  if (deckV2 && input.current && mentionsRestyle(input.instruction)) {
    const restyle = await proposeDeckRestyle({ ...input, current: input.current });
    if (restyle) return restyle;
  }
  if (input.kind === 'sheet') {
    const current = input.current || {
      documentId: 'new-workbook',
      title: 'Untitled spreadsheet',
      kind: 'sheet' as const,
      currentRevision: 1,
      createdAt: 0,
      updatedAt: 0,
      sourceRefs: [],
      model: createDefaultDocumentModel('sheet', 'new-workbook'),
    };
    const proposal = await generateSheetChangeSet({ ...input, current });
    return input.current
      ? proposal
      : {
          ...proposal,
          model: await applySpreadsheetChanges(current.model, proposal.model as SheetChangeSet),
        };
  }
  const schema = outputSchema(input.kind, input.current?.model);
  const modelSchema = modelSchemaFor(input.kind, input.current?.model);
  const current = input.current
    ? `Current ${documentKindLabel(input.kind).toLowerCase()}:\n${JSON.stringify({
        title: input.current.title,
        model: input.current.model,
      }).slice(0, 120_000)}`
    : `Create a new ${documentKindLabel(input.kind).toLowerCase()}.`;
  const sources = input.sourceContext?.trim()
    ? `\nGrounding material:\n${input.sourceContext.trim().slice(0, 40_000)}`
    : '';
  const { object } = await dependencies.generateObjectForCurrentUser<z.infer<typeof schema>>({
    userId: input.userId,
    userEmail: input.userEmail,
    userName: input.userName,
    feature: input.current ? 'document_suggestion' : 'document_generation',
    abortSignal: input.abortSignal,
    speed: 'primary',
    maxOutputTokens: 14_000,
    schema,
    system: `You are Albatross's document editor. Produce a complete, directly editable canonical model for the requested ${documentKindLabel(input.kind).toLowerCase()}.
${modelGuidance(input.kind, input.current?.model)}
${input.kind === 'deck' ? 'Preserve the existing art direction, background and text colors, spacing and visual hierarchy. Add real slide content with varied layouts; never put editing instructions into slides. All elements must fit within the 0–100 canvas. Never invent numbers; use metrics only when the grounding material supplies them.' : ''}
Preserve accurate supplied facts, never invent citations or claim provider-side changes, and make the result useful without extra cleanup. Return the full model, a concise title, and a one-sentence summary of what changed.`,
    prompt: `${current}${sources}\n\nUser instruction:\n${input.instruction.trim().slice(0, 20_000)}`,
  });
  try {
    const parsed = schema.parse(object);
    if (parsed.model.kind === 'deck') {
      if (!presentationSlideCountMatches(input.instruction, parsed.model.slides.length))
        throw new DocumentGenerationError(
          `The generator returned ${parsed.model.slides.length} slides outside the requested count constraints. No incomplete deck was saved.`,
        );
    }
    if (
      input.current &&
      parsed.title === input.current.title &&
      JSON.stringify(parsed.model) === JSON.stringify(modelSchema.parse(input.current.model))
    )
      throw new DocumentGenerationError('The generated revision contains no changes. Nothing was applied.');
    return parsed as {
      title: string;
      summary: string;
      model: AlbatrossDocumentModel;
    };
  } catch (error) {
    if (error instanceof DocumentGenerationError) throw error;
    throw new DocumentGenerationError(`The document model returned invalid ${input.kind} output.`, {
      cause: error,
    });
  }
}

import { z } from 'zod';
import { generateObjectForCurrentUser } from '@/lib/ai/gateway';
import {
  type AlbatrossDocumentModel,
  type AlbatrossDocumentRecord,
  createDefaultDocumentModel,
  type DocumentKind,
  deckModelSchema,
  docModelSchema,
  documentKindLabel,
  isSheetWorkbookModel,
  type SheetChangeSet,
  sheetModelSchema,
} from './model';
import {
  composePresentation,
  PRESENTATION_DESIGN_GUIDANCE,
  presentationBriefSchema,
  presentationSlideCountMatches,
} from './presentation-design';
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

function outputSchema(kind: DocumentKind) {
  return z.object({
    title: z.string().min(1).max(500),
    summary: z.string().min(1).max(1_000),
    model: schemas[kind],
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

function modelGuidance(kind: DocumentKind) {
  if (kind === 'doc') {
    return `Create structured blocks. Use heading blocks for hierarchy, paragraphs for prose, bullet or numbered blocks for lists, and quote only for attributed/source language. Keep block ids short and unique.`;
  }
  if (kind === 'sheet') {
    return `Create one or more useful sheets. Store sparse cells in A1 notation. Put labels in cells and formulas in formula without a leading equals sign. Include the formulas and structure needed to make the workbook useful, not just a prose summary.`;
  }
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
}): Promise<DocumentProposal> {
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

export async function generateDocumentProposal(input: {
  userId: string;
  userEmail?: string;
  userName?: string;
  kind: DocumentKind;
  instruction: string;
  current?: AlbatrossDocumentRecord;
  sourceContext?: string;
}): Promise<DocumentProposal> {
  const blankDeck =
    input.current?.model.kind === 'deck' &&
    input.current.model.slides.every((slide) =>
      slide.elements.every((element) => element.type === 'text' && !element.text?.trim()),
    );
  if (input.kind === 'deck' && (!input.current || blankDeck)) {
    const { object } = await dependencies.generateObjectForCurrentUser({
      userId: input.userId,
      feature: 'document_generation',
      speed: 'primary',
      maxOutputTokens: 14_000,
      schema: presentationBriefSchema,
      system: PRESENTATION_DESIGN_GUIDANCE,
      prompt: `Create a new presentation.\nGrounding material:\n${input.sourceContext?.trim().slice(0, 40_000) || 'No sources supplied; do not invent personal activity.'}\nUser instruction:\n${input.instruction.trim().slice(0, 20_000)}`,
    });
    try {
      const brief = presentationBriefSchema.parse(object);
      if (!presentationSlideCountMatches(input.instruction, brief.slides.length))
        throw new DocumentGenerationError(
          `The generator returned ${brief.slides.length} slides outside the requested count constraints. No incomplete deck was saved.`,
        );
      return { title: brief.title, summary: brief.summary, model: composePresentation(brief) };
    } catch (error) {
      throw new DocumentGenerationError('The presentation generator returned an incomplete design.', {
        cause: error,
      });
    }
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
  const schema = outputSchema(input.kind);
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
    speed: 'primary',
    maxOutputTokens: 14_000,
    schema,
    system: `You are Albatross's document editor. Produce a complete, directly editable canonical model for the requested ${documentKindLabel(input.kind).toLowerCase()}.
${modelGuidance(input.kind)}
${input.kind === 'deck' ? 'Preserve the existing art direction, background and text colors, spacing and visual hierarchy. Add real slide content with varied layouts; never put editing instructions into slides. All elements must fit within the 0–100 canvas.' : ''}
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
      JSON.stringify(parsed.model) === JSON.stringify(schemas[input.kind].parse(input.current.model))
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

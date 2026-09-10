import { z } from 'zod';
import { generateObjectForCurrentUser } from '@/lib/ai/gateway';
import {
  type AlbatrossDocumentModel,
  type AlbatrossDocumentRecord,
  type DocumentKind,
  deckModelSchema,
  docModelSchema,
  documentKindLabel,
  isSheetWorkbookModel,
  type SheetChangeSet,
  sheetModelSchema,
} from './model';
import { MAX_SHEET_CHANGES, sheetChangeSchema, workbookText } from './sheet-workbook';

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

const sheetChangesOutputSchema = z.object({
  title: z.string().min(1).max(500),
  summary: z.string().min(1).max(1_000),
  changes: z.array(sheetChangeSchema).min(1).max(MAX_SHEET_CHANGES),
  newSheets: z.array(z.string().min(1).max(200)).max(20).optional(),
});

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
 * Engine-backed workbooks are never regenerated wholesale: the server cannot
 * evaluate them, and a full rewrite would drop formatting, charts, and
 * validation. The model proposes cell-level changes that the editor applies
 * as undoable engine commands after the user reviews them.
 */
async function generateSheetChangeSet(input: {
  userId: string;
  userEmail?: string;
  userName?: string;
  instruction: string;
  current: AlbatrossDocumentRecord;
  sourceContext?: string;
}): Promise<DocumentProposal> {
  if (!isSheetWorkbookModel(input.current.model)) throw new Error('Expected an engine workbook.');
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
    system: `You are Albatross's spreadsheet assistant. The workbook below lists each sheet name followed by its non-empty cells as "A1: content". Propose only cell-level changes: give the exact sheet name, an A1 cell reference, and the new content. Formulas start with "=". Put names of sheets that do not exist yet in newSheets. Never invent data that is not in the workbook or grounding material. Return a concise title for the revision and a one-sentence summary.`,
    prompt: `Current spreadsheet "${input.current.title}":\n${workbookText(input.current.model).slice(0, 120_000)}${sources}\n\nUser instruction:\n${input.instruction.trim().slice(0, 20_000)}`,
  });
  let parsed: z.infer<typeof sheetChangesOutputSchema>;
  try {
    parsed = sheetChangesOutputSchema.parse(object);
  } catch (error) {
    throw new DocumentGenerationError('The spreadsheet model returned invalid cell changes.', {
      cause: error,
    });
  }
  return {
    title: parsed.title,
    summary: parsed.summary,
    model: { kind: 'sheet-changes', version: 1, changes: parsed.changes, newSheets: parsed.newSheets },
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
  if (input.current && isSheetWorkbookModel(input.current.model)) {
    return generateSheetChangeSet({ ...input, current: input.current });
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
Preserve accurate supplied facts, never invent citations or claim provider-side changes, and make the result useful without extra cleanup. Return the full model, a concise title, and a one-sentence summary of what changed.`,
    prompt: `${current}${sources}\n\nUser instruction:\n${input.instruction.trim().slice(0, 20_000)}`,
  });
  try {
    return schema.parse(object) as {
      title: string;
      summary: string;
      model: AlbatrossDocumentModel;
    };
  } catch (error) {
    throw new DocumentGenerationError(`The document model returned invalid ${input.kind} output.`, {
      cause: error,
    });
  }
}

import { z } from 'zod';
import { generateObjectForCurrentUser } from '@/lib/ai/gateway';
import {
  type AlbatrossDocumentModel,
  type AlbatrossDocumentRecord,
  type DocumentKind,
  deckModelSchema,
  docModelSchema,
  documentKindLabel,
  sheetModelSchema,
} from './model';

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

function modelGuidance(kind: DocumentKind) {
  if (kind === 'doc') {
    return `Create structured blocks. Use heading blocks for hierarchy, paragraphs for prose, bullet or numbered blocks for lists, and quote only for attributed/source language. Keep block ids short and unique.`;
  }
  if (kind === 'sheet') {
    return `Create one or more useful sheets. Store sparse cells in A1 notation. Put labels in cells and formulas in formula without a leading equals sign. Include the formulas and structure needed to make the workbook useful, not just a prose summary.`;
  }
  return `Create a presentation as 16:9 slides. Every element uses percentage coordinates from 0 to 100. Use concise slide titles, readable body text, a clear visual hierarchy, speaker notes when useful, and short unique ids.`;
}

export async function generateDocumentProposal(input: {
  userId: string;
  userEmail?: string;
  userName?: string;
  kind: DocumentKind;
  instruction: string;
  current?: AlbatrossDocumentRecord;
  sourceContext?: string;
}) {
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

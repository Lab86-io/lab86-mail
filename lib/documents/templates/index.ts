// Word templates (docs/albatross-goal-runs.md, G4). The model sends typed
// data; the server renders an official-looking DOCX in the house style with
// embedded fonts. An empty value becomes a blank (a Word content control).

import { Packer } from 'docx';
import { z } from 'zod';
import { OfficeError } from '../office-security';
import { TemplateCanvas } from './house';
import { buildInvoice, invoiceDataSchema } from './invoice';
import { buildLetter, letterDataSchema } from './letter';
import { buildMemo, memoDataSchema } from './memo';
import { finalizeTemplatePackage } from './package';
import { buildReport, reportDataSchema } from './report';

export const DOCUMENT_TEMPLATES = ['invoice', 'letter', 'memo', 'report'] as const;
export type DocumentTemplate = (typeof DOCUMENT_TEMPLATES)[number];

export const templateDataSchemas = {
  invoice: invoiceDataSchema,
  letter: letterDataSchema,
  memo: memoDataSchema,
  report: reportDataSchema,
} as const;

const builders = {
  invoice: buildInvoice,
  letter: buildLetter,
  memo: buildMemo,
  report: buildReport,
} as const;

/**
 * The model-facing `data` field: one shape for each template. The variants
 * are loose, so the union keeps every key; the template's own schema then
 * checks the data (see `templateDataIssues`).
 */
export const templateDataInputSchema = z
  .union([
    invoiceDataSchema
      .loose()
      .describe(
        'invoice: from, billTo, number, issued, period, engagement, items, currency, payment, notes.',
      ),
    letterDataSchema
      .loose()
      .describe('letter: from, to, date, subject, salutation, body, closing, signature.'),
    memoDataSchema.loose().describe('memo: to, from, date, subject, body.'),
    reportDataSchema.loose().describe('report: title, subtitle, author, date, sections.'),
  ])
  .describe(
    'The content for the template, in the shape of that template. Send facts only: no fonts, sizes, colors, or borders. Leave a value empty when you cannot find it; it becomes a blank for the user.',
  );

export function templateDataIssues(template: DocumentTemplate, data: unknown) {
  const result = templateDataSchemas[template].safeParse(data);
  return result.success ? [] : result.error.issues;
}

export interface RenderedTemplate {
  bytes: Uint8Array;
  /** Blank names in page order. */
  blanks: string[];
}

export async function renderTemplate(
  template: DocumentTemplate,
  data: unknown,
  options: { title?: string; fontRoot?: string } = {},
): Promise<RenderedTemplate> {
  const schema = templateDataSchemas[template];
  if (!schema) throw new OfficeError(`Unknown template "${String(template)}".`);
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new OfficeError(
      `The ${template} data is not valid: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || 'data'}: ${issue.message}`)
        .join('; ')}`,
    );
  const canvas = new TemplateCanvas();
  const title = options.title?.trim() || template[0].toUpperCase() + template.slice(1);
  const build = builders[template] as (
    canvas: TemplateCanvas,
    data: unknown,
    title: string,
  ) => ReturnType<typeof buildInvoice>;
  const packed = await Packer.toBuffer(build(canvas, parsed.data, title));
  return finalizeTemplatePackage(new Uint8Array(packed), canvas, { fontRoot: options.fontRoot });
}

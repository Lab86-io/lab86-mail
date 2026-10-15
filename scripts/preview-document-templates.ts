// Render each Word template with invented sample data.
// Usage: bun scripts/preview-document-templates.ts [output directory]
// Then convert with LibreOffice: soffice --headless --convert-to pdf --outdir <dir> <dir>/*.docx
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderTemplate } from '../lib/documents/templates';
import { sampleInvoice, sampleLetter, sampleMemo, sampleReport } from './fixtures/document-template-samples';

const out = process.argv[2] || '/tmp/goal-docs-preview';
mkdirSync(out, { recursive: true });
const samples = {
  invoice: [sampleInvoice, 'Invoice INV-1042'],
  letter: [sampleLetter, 'Proposal for the patient portal redesign'],
  memo: [sampleMemo, 'New check-in process'],
  report: [sampleReport, 'Patient portal use, third quarter 2026'],
} as const;
for (const [template, [data, title]] of Object.entries(samples)) {
  const rendered = await renderTemplate(template as keyof typeof samples, data, { title });
  const file = path.join(out, `${template}.docx`);
  writeFileSync(file, rendered.bytes);
  console.log(file, rendered.bytes.byteLength, 'bytes; blanks:', rendered.blanks.join(', ') || 'none');
}

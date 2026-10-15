// Render each Word template with invented sample data.
// Usage: bun scripts/preview-document-templates.ts [output directory]
// Then convert with LibreOffice: soffice --headless --convert-to pdf --outdir <dir> <dir>/*.docx
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderTemplate } from '../lib/documents/templates';
import { sampleInvoice, sampleLetter, sampleMemo, sampleReport } from './fixtures/document-template-samples';

const out = process.argv[2] || '/tmp/goal-docs-preview';
mkdirSync(out, { recursive: true });
const samples = [
  ['invoice', 'invoice', sampleInvoice, 'Invoice INV-1042'],
  [
    'invoice-adjusted',
    'invoice',
    {
      ...sampleInvoice,
      adjustments: [
        { label: 'Sales tax 6.25%', percent: 6.25 },
        { label: 'Returning client discount', amount: -100 },
      ],
    },
    'Invoice INV-1042',
  ],
  ['letter', 'letter', sampleLetter, 'Proposal for the patient portal redesign'],
  ['memo', 'memo', sampleMemo, 'New check-in process'],
  ['report', 'report', sampleReport, 'Patient portal use, third quarter 2026'],
] as const;
for (const [name, template, data, title] of samples) {
  const rendered = await renderTemplate(template, data, { title });
  const file = path.join(out, `${name}.docx`);
  writeFileSync(file, rendered.bytes);
  console.log(file, rendered.bytes.byteLength, 'bytes; blanks:', rendered.blanks.join(', ') || 'none');
}

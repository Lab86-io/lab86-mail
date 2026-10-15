// Writes public/dev/w9-sample.pdf: a one-page sample form that looks like a
// W-9 request for a taxpayer identification number, with fillable fields, for
// the thread dev harness and the tests. No real person is on it: the values
// are the invented Sam Rivera of the fixtures, and the tax ID field is empty.
// Hand-written PDF 1.4, so no PDF library is needed to make it.
//
//   node scripts/dev/make-w9-sample.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '../../public/dev/w9-sample.pdf');

const esc = (text) => text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const line = (x, y, text, size = 9, font = 'Helv') =>
  `BT /${font} ${size} Tf ${x} ${y} Td (${esc(text)}) Tj ET`;
const rule = (x1, y1, x2, y2, w = 0.8) => `${w} w ${x1} ${y1} m ${x2} ${y2} l S`;
const box = (x, y, w, h) => `0.8 w ${x} ${y} ${w} ${h} re S`;

// Letter page, 612 x 792. The content stream.
const content = [
  '0 g',
  line(40, 740, 'Form', 8),
  line(40, 718, 'W-9', 22, 'HelvB'),
  line(40, 704, '(Sample for the dev harness)', 7),
  line(170, 736, 'Request for Taxpayer', 13, 'HelvB'),
  line(170, 720, 'Identification Number and Certification', 13, 'HelvB'),
  line(450, 740, 'Give form to the requester.', 7),
  line(450, 730, 'Do not send to the IRS.', 7),
  rule(40, 696, 572, 696, 1.5),
  line(44, 680, '1  Name of entity/individual.', 8),
  rule(40, 668, 572, 668),
  line(44, 652, '2  Business name/disregarded entity name, if different from above.', 8),
  rule(40, 640, 572, 640),
  line(44, 624, '3a Check the appropriate box for federal tax classification:', 8),
  box(44, 604, 8, 8),
  line(56, 606, 'Individual/sole proprietor', 8),
  box(190, 604, 8, 8),
  line(202, 606, 'C corporation', 8),
  box(290, 604, 8, 8),
  line(302, 606, 'S corporation', 8),
  box(390, 604, 8, 8),
  line(402, 606, 'Partnership', 8),
  rule(40, 596, 572, 596),
  line(44, 580, '5  Address (number, street, and apt. or suite no.)', 8),
  rule(40, 568, 572, 568),
  line(44, 552, '6  City, state, and ZIP code', 8),
  rule(40, 540, 572, 540, 1.5),
  '0 g 40 512 200 14 re f',
  '1 g',
  line(44, 516, 'Part I   Taxpayer Identification Number (TIN)', 9, 'HelvB'),
  '0 g',
  line(44, 496, 'Social security number', 7),
  ...[0, 1, 2, 4, 5, 7, 8, 9, 10].map((n) => box(44 + n * 16, 470, 14, 18)),
  line(320, 496, 'Employer identification number', 7),
  ...[0, 1, 3, 4, 5, 6, 7, 8, 9].map((n) => box(320 + n * 16, 470, 14, 18)),
  '0 g 40 440 120 14 re f',
  '1 g',
  line(44, 444, 'Part II   Certification', 9, 'HelvB'),
  '0 g',
  line(44, 426, 'Under penalties of perjury, I certify that the number shown on this form is my correct', 7),
  line(44, 416, 'taxpayer identification number ...', 7),
  line(44, 380, 'Signature of U.S. person', 8),
  rule(160, 376, 420, 376),
  line(440, 380, 'Date', 8),
  rule(470, 376, 572, 376),
].join('\n');

// The fields: a text field for each line, one for the tax ID (sealed in the
// fixtures), and a signature field.
const fields = [
  { name: 'name', type: 'Tx', rect: [240, 670, 570, 690], value: 'SAM RIVERA' },
  { name: 'business_name', type: 'Tx', rect: [330, 642, 570, 662], value: '' },
  { name: 'address', type: 'Tx', rect: [300, 570, 570, 590], value: '12 ELM STREET, APT 3' },
  { name: 'city_state_zip', type: 'Tx', rect: [200, 542, 570, 562], value: 'SPRINGFIELD, IL 62704' },
  { name: 'ssn', type: 'Tx', rect: [44, 470, 202, 488], value: '' },
  { name: 'ein', type: 'Tx', rect: [320, 470, 478, 488], value: '' },
  { name: 'signature', type: 'Sig', rect: [160, 376, 420, 396], value: null },
];

const objects = [];
const add = (body) => {
  objects.push(body);
  return objects.length;
};
const catalog = add(null); // 1, filled below
const pages = add(null); // 2
const page = add(null); // 3
const contentObj = add(
  `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
); // 4
const helv = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); // 5
const helvB = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'); // 6
const fieldIds = fields.map((field) => {
  const value = field.value === null ? '' : ` /V (${esc(field.value)})`;
  const da = field.type === 'Tx' ? ' /DA (/Helv 9 Tf 0 g)' : '';
  return add(
    `<< /Type /Annot /Subtype /Widget /FT /${field.type} /T (${field.name}) /Rect [${field.rect.join(' ')}] /F 4 /P ${page} 0 R${value}${da} >>`,
  );
});
objects[page - 1] =
  `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${contentObj} 0 R ` +
  `/Resources << /Font << /Helv ${helv} 0 R /HelvB ${helvB} 0 R >> >> /Annots [${fieldIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
objects[pages - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`;
objects[catalog - 1] =
  `<< /Type /Catalog /Pages ${pages} 0 R /AcroForm << /Fields [${fieldIds.map((id) => `${id} 0 R`).join(' ')}] ` +
  `/DR << /Font << /Helv ${helv} 0 R >> >> /DA (/Helv 9 Tf 0 g) /NeedAppearances true >> >>`;

let pdf = '%PDF-1.4\n%âãÏÓ\n';
const offsets = [];
objects.forEach((body, index) => {
  offsets.push(Buffer.byteLength(pdf, 'latin1'));
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(pdf, 'latin1'));
console.log('wrote', out, Buffer.byteLength(pdf, 'latin1'), 'bytes');

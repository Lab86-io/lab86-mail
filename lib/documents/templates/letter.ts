// Letter template: a letterhead with the sender, the date, the recipient
// block, the subject, the body, the closing, and the signature. The first
// page has no footer; the next pages show the sender and the page number.

import { AlignmentType, Document, Footer, Table, TableRow, WidthType } from 'docx';
import { z } from 'zod';
import {
  cell,
  cleanText,
  displayDate,
  houseNumbering,
  houseStyles,
  MUTED,
  NO_TABLE_BORDERS,
  pageProperties,
  SERIF,
  SIZE,
  type TemplateCanvas,
  CONTENT_WIDTH as WIDTH,
} from './house';

const person = z.object({
  name: z
    .string()
    .max(200)
    .optional()
    .describe('Person or company name. Leave it empty when you cannot find it; it becomes a blank.'),
  lines: z.array(z.string().max(200)).max(6).optional().describe('Address, email, or phone, one line each.'),
});

export const letterDataSchema = z.object({
  from: person.describe('The sender (the user). The name heads the letter.'),
  to: person.describe('The recipient.'),
  date: z
    .string()
    .max(60)
    .optional()
    .describe('Date as YYYY-MM-DD (shown as "October 15, 2026"). Empty makes a blank.'),
  subject: z
    .string()
    .max(200)
    .optional()
    .describe('One line about the letter. Omit it for a personal letter.'),
  salutation: z
    .string()
    .max(120)
    .optional()
    .describe('For example "Dear Dr. Rivera,". The default is "Dear <recipient name>,".'),
  body: z
    .array(z.string().min(1).max(4_000))
    .min(1)
    .max(40)
    .describe('The paragraphs, in order. Start a paragraph with "- " to make a bullet.'),
  closing: z
    .string()
    .max(60)
    .optional()
    .describe('For example "Kind regards,". The default is "Sincerely,".'),
  signature: z
    .object({
      name: z.string().max(120).optional().describe('The signer. The default is the sender name.'),
      title: z.string().max(160).optional().describe('Job title or role under the name.'),
    })
    .optional(),
});
export type LetterData = z.infer<typeof letterDataSchema>;

export function buildLetter(canvas: TemplateCanvas, data: LetterData, title: string) {
  const c = canvas;
  const fromName = cleanText(data.from.name);
  const toName = cleanText(data.to.name);
  const fromLines = (data.from.lines ?? []).map(cleanText).filter(Boolean);
  const subject = cleanText(data.subject);
  const signerTitle = cleanText(data.signature?.title);
  const salutation = cleanText(data.salutation) || (toName ? `Dear ${toName},` : '');

  const letterhead = new Table({
    width: { size: WIDTH, type: WidthType.DXA },
    columnWidths: [Math.round(WIDTH * 0.55), Math.round(WIDTH * 0.45)],
    borders: NO_TABLE_BORDERS,
    rows: [
      new TableRow({
        children: [
          cell([c.paragraph(c.value(data.from.name, 'Your name', { font: SERIF, size: 40 }))], WIDTH * 0.55),
          cell(
            fromLines.length
              ? fromLines.map((line, index) =>
                  c.paragraph([c.run(line, { size: SIZE.small, color: MUTED })], {
                    align: AlignmentType.RIGHT,
                    before: index ? 0 : 60,
                  }),
                )
              : [c.paragraph([c.run('')])],
            WIDTH * 0.45,
          ),
        ],
      }),
    ],
  });

  return new Document({
    title,
    creator: fromName || 'Albatross',
    styles: houseStyles(),
    numbering: houseNumbering(),
    sections: [
      {
        properties: pageProperties(true),
        footers: {
          first: new Footer({ children: [c.paragraph([c.run('')])] }),
          default: new Footer({ children: [c.footer(fromName)] }),
        },
        children: [
          letterhead,
          c.paragraph([c.run('')], { ruleBelow: true, after: 600 }),
          c.paragraph(c.value(data.date, 'Date', {}, { display: displayDate }), { after: 360 }),
          c.paragraph(c.value(data.to.name, 'Recipient name', { bold: true })),
          ...(data.to.lines ?? [])
            .map(cleanText)
            .filter(Boolean)
            .map((line) => c.paragraph([c.run(line)])),
          c.spacer(360),
          ...(subject ? [c.paragraph([c.run(subject, { bold: true })], { after: 240 })] : []),
          c.paragraph(c.value(salutation, 'Salutation'), { after: 200 }),
          ...c.body(data.body, {}, 200),
          c.paragraph(c.value(cleanText(data.closing) || 'Sincerely,', 'Closing'), {
            before: 120,
            after: 720,
          }),
          c.paragraph(c.value(cleanText(data.signature?.name) || fromName, 'Your name', { bold: true })),
          ...(signerTitle ? [c.paragraph([c.run(signerTitle, { color: MUTED })])] : []),
        ],
      },
    ],
  });
}

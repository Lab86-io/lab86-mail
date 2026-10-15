// Memo template: the title, a block of To, From, Date, and Subject with
// hairline rules, then the body.

import { Document, Table, TableRow, WidthType } from 'docx';
import { z } from 'zod';
import {
  cell,
  cleanText,
  displayDate,
  hairline,
  houseNumbering,
  houseStyles,
  INK,
  MUTED,
  NO_TABLE_BORDERS,
  pageProperties,
  SERIF,
  SIZE,
  type TemplateCanvas,
  CONTENT_WIDTH as WIDTH,
} from './house';

export const memoDataSchema = z.object({
  to: z
    .string()
    .max(300)
    .optional()
    .describe('The readers, for example "Clinic staff". Empty makes a blank.'),
  from: z
    .string()
    .max(200)
    .optional()
    .describe('The writer (the user), with a role if useful. Empty makes a blank.'),
  date: z
    .string()
    .max(60)
    .optional()
    .describe('Date as YYYY-MM-DD (shown as "October 15, 2026"). Empty makes a blank.'),
  subject: z.string().max(200).optional().describe('One line. Empty makes a blank.'),
  body: z
    .array(z.string().min(1).max(4_000))
    .min(1)
    .max(40)
    .describe('The paragraphs, in order. Start a paragraph with "- " to make a bullet.'),
});
export type MemoData = z.infer<typeof memoDataSchema>;

export function buildMemo(canvas: TemplateCanvas, data: MemoData, title: string) {
  const c = canvas;
  const labelWidth = 1440;
  const fields: Array<[string, ReturnType<TemplateCanvas['value']>]> = [
    ['To', c.value(data.to, 'To')],
    ['From', c.value(data.from, 'From')],
    ['Date', c.value(data.date, 'Date', {}, { display: displayDate })],
    ['Subject', c.value(data.subject, 'Subject', { bold: true })],
  ];
  const block = new Table({
    width: { size: WIDTH, type: WidthType.DXA },
    columnWidths: [labelWidth, WIDTH - labelWidth],
    borders: NO_TABLE_BORDERS,
    rows: fields.map(([label, value], index) => {
      // Ink rules above the first row and under the last; hairlines between.
      const borders = {
        top: index ? hairline() : hairline(INK, 8),
        ...(index === fields.length - 1 ? { bottom: hairline(INK, 8) } : {}),
      };
      return new TableRow({
        cantSplit: true,
        children: [
          cell(
            [c.paragraph([c.run(label, { size: SIZE.small, color: MUTED })], { before: 20 })],
            labelWidth,
            {
              borders,
              top: 120,
              bottom: 120,
            },
          ),
          cell([c.paragraph(value)], WIDTH - labelWidth, { borders, top: 120, bottom: 120 }),
        ],
      });
    }),
  });
  const subject = cleanText(data.subject);
  return new Document({
    title,
    creator: cleanText(data.from) || 'Albatross',
    styles: houseStyles(),
    numbering: houseNumbering(),
    sections: [
      {
        properties: pageProperties(true),
        footers: c.pageFooters(subject || 'Memo'),
        children: [
          c.paragraph([c.run('Memo', { font: SERIF, size: SIZE.title })], { after: 360 }),
          block,
          c.spacer(480),
          ...c.body(data.body),
        ],
      },
    ],
  });
}

// Report template: a title block, then sections with a heading, paragraphs,
// and an optional table. Headings use the Heading 1 style, so the navigator
// and a table of contents in Word find them.

import { AlignmentType, Document, Table, TableRow, WidthType } from 'docx';
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

const reportTable = z.object({
  columns: z.array(z.string().max(80)).min(1).max(8).describe('Column headings.'),
  rows: z
    .array(z.array(z.string().max(400)).min(1).max(8))
    .min(1)
    .max(60)
    .describe('Rows of cell text, each as long as columns. Numbers align right.'),
  caption: z.string().max(300).optional().describe('One line under the table, for example the source.'),
});

export const reportDataSchema = z.object({
  title: z.string().min(1).max(200).describe('The report title.'),
  subtitle: z.string().max(300).optional().describe('One line under the title.'),
  author: z.string().max(200).optional().describe('Who wrote it. Omit it when unknown.'),
  date: z
    .string()
    .max(60)
    .optional()
    .describe('Date as YYYY-MM-DD (shown as "October 15, 2026"). Empty makes a blank.'),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(200),
        paragraphs: z
          .array(z.string().min(1).max(4_000))
          .max(40)
          .describe('The paragraphs, in order. Start a paragraph with "- " to make a bullet.'),
        table: reportTable.optional(),
      }),
    )
    .min(1)
    .max(30),
});
export type ReportData = z.infer<typeof reportDataSchema>;

/** A cell that reads as a number, an amount, or a percent aligns right. */
export function isNumericCell(value: string) {
  const text = value.trim();
  return Boolean(text) && /^[-+(]?[$€£¥]?\s?[\d.,]+\s?(?:%|[kKmMbB])?\)?$/.test(text);
}

function buildTable(c: TemplateCanvas, table: z.infer<typeof reportTable>) {
  const count = table.columns.length;
  const rows = table.rows.map((row) => Array.from({ length: count }, (_, index) => cleanText(row[index])));
  const numeric = table.columns.map((_, index) => {
    const values = rows.map((row) => row[index]).filter(Boolean);
    return values.length > 0 && values.every(isNumericCell);
  });
  // The first column is wider when it holds the labels of the rows.
  const first = count > 1 ? Math.max(WIDTH / count, WIDTH * 0.34) : WIDTH;
  const widths = table.columns.map((_, index) => (index ? (WIDTH - first) / (count - 1) : first));
  const align = (index: number) => (numeric[index] ? AlignmentType.RIGHT : undefined);
  const head = new TableRow({
    tableHeader: true,
    children: table.columns.map((text, index) =>
      cell(
        [c.paragraph([c.run(cleanText(text), { size: SIZE.small, color: MUTED })], { align: align(index) })],
        widths[index],
        { borders: { bottom: hairline(INK, 6) }, bottom: 80 },
      ),
    ),
  });
  const body = rows.map(
    (row) =>
      new TableRow({
        cantSplit: true,
        children: row.map((text, index) =>
          cell([c.paragraph([c.run(text, { size: 18 })], { align: align(index) })], widths[index], {
            borders: { bottom: hairline() },
            top: 90,
            bottom: 90,
          }),
        ),
      }),
  );
  return new Table({
    width: { size: WIDTH, type: WidthType.DXA },
    columnWidths: widths.map(Math.round),
    borders: NO_TABLE_BORDERS,
    rows: [head, ...body],
  });
}

export function buildReport(canvas: TemplateCanvas, data: ReportData, title: string) {
  const c = canvas;
  const reportTitle = cleanText(data.title) || title;
  const subtitle = cleanText(data.subtitle);
  const author = cleanText(data.author);
  // Author and date on their own lines, with no separator characters.
  const byline = [
    ...(author ? [c.paragraph([c.run(author, { color: MUTED })], { after: 40 })] : []),
    c.paragraph(c.value(data.date, 'Date', { color: MUTED }, { display: displayDate }), {
      ruleBelow: true,
      after: 480,
    }),
  ];
  return new Document({
    title,
    creator: author || 'Albatross',
    styles: houseStyles(),
    numbering: houseNumbering(),
    sections: [
      {
        properties: pageProperties(true),
        footers: c.pageFooters(reportTitle),
        children: [
          c.paragraph([c.run(reportTitle, { font: SERIF, size: 56 })], { after: subtitle ? 120 : 240 }),
          ...(subtitle
            ? [c.paragraph([c.run(subtitle, { size: SIZE.lead, color: MUTED })], { after: 240 })]
            : []),
          ...byline,
          ...data.sections.flatMap((section) => [
            c.paragraph([c.run(cleanText(section.heading), { font: SERIF, size: SIZE.heading })], {
              style: 'Heading1',
              before: 360,
              after: 120,
              keepNext: true,
            }),
            ...c.body(section.paragraphs),
            ...(section.table
              ? [
                  c.spacer(80),
                  buildTable(c, section.table),
                  ...(cleanText(section.table.caption)
                    ? [
                        c.paragraph(
                          [c.run(cleanText(section.table.caption), { size: SIZE.small, color: MUTED })],
                          {
                            before: 100,
                            after: 160,
                          },
                        ),
                      ]
                    : [c.spacer(160)]),
                ]
              : []),
          ]),
        ],
      },
    ],
  });
}

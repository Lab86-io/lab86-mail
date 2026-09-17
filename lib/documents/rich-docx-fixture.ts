import {
  AlignmentType,
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

/**
 * A synthetic Word file with the features the editor acceptance covers: a
 * heading, body text, a table, an image, two comments, a header, a footer
 * with page numbers, and a second page. Used by the live Collabora
 * verification so save and reopen are proven on a real document, not a blank.
 */

async function samplePng(): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(320, 200);
  const context = canvas.getContext('2d');
  context.fillStyle = '#F4F1EA';
  context.fillRect(0, 0, 320, 200);
  context.fillStyle = '#AE4B2B';
  context.fillRect(24, 24, 120, 152);
  context.fillStyle = '#1E2A38';
  context.beginPath();
  context.arc(232, 100, 60, 0, Math.PI * 2);
  context.fill();
  return canvas.toBuffer('image/png');
}

export async function buildRichDocxFixture(): Promise<Uint8Array> {
  const image = await samplePng();
  const cell = (text: string, bold = false) =>
    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold })] })] });
  const file = new Document({
    title: 'Albatross rich verification',
    comments: {
      children: [
        {
          id: 0,
          author: 'Albatross',
          date: new Date('2026-09-15T00:00:00Z'),
          children: [new Paragraph('Check this figure against the treasurer report.')],
        },
        {
          id: 1,
          author: 'Albatross',
          date: new Date('2026-09-15T00:00:00Z'),
          children: [new Paragraph('Keep the image at this width.')],
        },
      ],
    },
    sections: [
      {
        headers: {
          default: new Header({
            children: [
              new Paragraph({ text: 'Lakeshore Trail · Board packet', alignment: AlignmentType.RIGHT }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun('Page '),
                  new TextRun({ children: [PageNumber.CURRENT] }),
                  new TextRun(' of '),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES] }),
                ],
              }),
            ],
          }),
        },
        children: [
          new Paragraph({ text: 'Phase two budget', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            children: [
              new TextRun('The rail bed gives a grade under three percent for the whole segment. '),
              new CommentRangeStart(0),
              new TextRun('Grading spend reached 310 thousand in the third quarter.'),
              new CommentRangeEnd(0),
              new TextRun({ children: [new CommentReference(0)] }),
            ],
          }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({ children: [cell('Quarter', true), cell('Spend', true), cell('Note', true)] }),
              new TableRow({ children: [cell('Q1'), cell('180k'), cell('Survey')] }),
              new TableRow({ children: [cell('Q2'), cell('240k'), cell('Permits')] }),
              new TableRow({ children: [cell('Q3'), cell('310k'), cell('Grading')] }),
            ],
          }),
          new Paragraph({ text: '' }),
          new Paragraph({
            children: [
              new CommentRangeStart(1),
              new ImageRun({
                type: 'png',
                data: image,
                transformation: { width: 320, height: 200 },
                altText: { title: 'Figure', description: 'Synthetic figure', name: 'figure' },
              }),
              new CommentRangeEnd(1),
              new TextRun({ children: [new CommentReference(1)] }),
            ],
          }),
          new Paragraph({
            children: [new TextRun({ text: 'Figure 1. Synthetic shapes for verification.', italics: true })],
          }),
          new Paragraph({ children: [new PageBreak()] }),
          new Paragraph({ text: 'Asks of the board', heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: 'Approve the phase two budget.', bullet: { level: 0 } }),
          new Paragraph({ text: 'Name a liaison for Millbrook.', bullet: { level: 0 } }),
          new Paragraph({ text: 'Set the opening date.', bullet: { level: 0 } }),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(file));
}

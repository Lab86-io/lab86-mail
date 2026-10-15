// Invoice template. Layout from the approved prototype of 2026-10-14:
// masthead, facts row, From and Bill to, engagement, line items with hairline
// rules, totals, payment. The server computes each amount and the totals.

import { AlignmentType, Document, Footer, Table, TableRow, WidthType } from 'docx';
import { z } from 'zod';
import {
  ACCENT,
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

const party = z.object({
  name: z
    .string()
    .max(200)
    .optional()
    .describe('Person or company name. Leave it empty when you cannot find it; it becomes a blank.'),
  lines: z
    .array(z.string().max(200))
    .max(6)
    .optional()
    .describe('Address, email, phone, or tax ID, one line each.'),
});

const invoiceItem = z.object({
  title: z
    .string()
    .min(1)
    .max(160)
    .describe('Short name of the line, for example "July 2026" or "Site visit".'),
  summary: z
    .string()
    .max(800)
    .optional()
    .describe('One or two sentences about the work. Leave it empty to make a blank.'),
  hours: z.number().min(0).max(100_000).optional().describe('Hours worked. Use hours or quantity.'),
  quantity: z.number().min(0).max(1_000_000_000).optional().describe('Units, for a line that is not hourly.'),
  rate: z.number().min(0).max(1_000_000_000).optional().describe('The price of one hour or one unit.'),
  amount: z
    .number()
    .min(-1_000_000_000)
    .max(1_000_000_000)
    .optional()
    .describe('The line total. Omit it: the server multiplies hours or quantity by the rate.'),
});

export const invoiceDataSchema = z.object({
  from: party.describe('The sender of the invoice (the user).'),
  billTo: party.describe('The client who pays.'),
  number: z
    .string()
    .max(60)
    .optional()
    .describe('Invoice number. Propose the next number after earlier invoices. Empty makes a blank.'),
  issued: z
    .string()
    .max(60)
    .optional()
    .describe('Invoice date as YYYY-MM-DD (shown as "October 15, 2026"). Empty makes a blank.'),
  period: z
    .string()
    .max(120)
    .optional()
    .describe('Service period, for example "June 1 to August 31, 2026". Omit it when it does not apply.'),
  engagement: z
    .string()
    .max(600)
    .optional()
    .describe('One sentence about the agreement, for example the offer letter and its date.'),
  items: z.array(invoiceItem).min(1).max(40).describe('The lines of the invoice, in order.'),
  currency: z.string().max(3).optional().describe('ISO 4217 code such as USD or EUR. The default is USD.'),
  payment: z
    .string()
    .max(800)
    .optional()
    .describe('How and when to pay: terms, due date, account. Empty makes a blank.'),
  notes: z.string().max(1_500).optional().describe('A short closing note. Omit it when not needed.'),
});
export type InvoiceData = z.infer<typeof invoiceDataSchema>;

/** Currency text such as "$3,510.00". An unknown code shows as "3,510.00 XYZ". */
export function formatMoney(value: number, currency = 'USD') {
  const code = cleanText(currency).toUpperCase() || 'USD';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(value);
  } catch {
    return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} ${code}`;
  }
}

export const formatQuantity = (value: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);

const cents = (value: number) => Math.round(value * 100) / 100;

export interface InvoiceLine {
  title: string;
  summary: string;
  quantity?: number;
  rate?: number;
  amount?: number;
}

export interface InvoiceTotals {
  lines: InvoiceLine[];
  hourly: boolean;
  /** Sum of the hours, when every hourly line has its hours. */
  hours?: number;
  /** Known only when every line has an amount. */
  total?: number;
}

/** Each line's amount (given, or quantity times rate) and the totals. */
export function invoiceTotals(data: InvoiceData): InvoiceTotals {
  const hourly = data.items.some((item) => item.hours !== undefined);
  const lines = data.items.map((item) => {
    const quantity = item.hours ?? item.quantity;
    const amount =
      item.amount ??
      (quantity !== undefined && item.rate !== undefined ? cents(quantity * item.rate) : undefined);
    return {
      title: cleanText(item.title),
      summary: cleanText(item.summary),
      quantity,
      rate: item.rate,
      amount,
    };
  });
  const known = lines.every((line) => line.amount !== undefined);
  const hours = data.items.every((item) => item.hours !== undefined)
    ? data.items.reduce((sum, item) => sum + (item.hours ?? 0), 0)
    : undefined;
  return {
    lines,
    hourly,
    ...(hourly && hours !== undefined ? { hours } : {}),
    ...(known ? { total: cents(lines.reduce((sum, line) => sum + (line.amount ?? 0), 0)) } : {}),
  };
}

export function buildInvoice(canvas: TemplateCanvas, data: InvoiceData, title: string) {
  const c = canvas;
  const currency = cleanText(data.currency).toUpperCase() || 'USD';
  const money = (value: number) => formatMoney(value, currency);
  const totals = invoiceTotals(data);
  const right = AlignmentType.RIGHT;
  const fromName = cleanText(data.from.name);
  const number = cleanText(data.number);
  const period = cleanText(data.period);
  const table = (columnWidths: number[], rows: TableRow[]) =>
    new Table({
      width: { size: WIDTH, type: WidthType.DXA },
      columnWidths: columnWidths.map(Math.round),
      borders: NO_TABLE_BORDERS,
      rows,
    });

  const masthead = table(
    [WIDTH * 0.6, WIDTH * 0.4],
    [
      new TableRow({
        children: [
          cell([c.paragraph([c.run('Invoice', { font: SERIF, size: SIZE.title })])], WIDTH * 0.6),
          cell(
            [
              c.paragraph(c.value(data.from.name, 'Your name', { bold: true }), {
                align: right,
                before: 120,
              }),
              ...(data.from.lines ?? [])
                .map(cleanText)
                .filter(Boolean)
                .map((line) => c.paragraph([c.run(line, { color: MUTED })], { align: right })),
            ],
            WIDTH * 0.4,
          ),
        ],
      }),
    ],
  );

  const amountDue =
    totals.total !== undefined
      ? [c.run(money(totals.total), { bold: true })]
      : [c.blank('Total due', { bold: true })];
  const facts: Array<[string, ReturnType<TemplateCanvas['value']>]> = [
    ['Invoice number', c.value(data.number, 'Invoice number')],
    ['Invoice date', c.value(data.issued, 'Invoice date', {}, { display: displayDate })],
    ...(period ? [['Service period', [c.run(period)]] as [string, ReturnType<TemplateCanvas['value']>]] : []),
    ['Amount due', amountDue],
  ];
  const factWidth = WIDTH / facts.length;
  const factRow = table(
    facts.map(() => factWidth),
    [
      new TableRow({
        children: facts.map(([label, value]) =>
          cell([c.label(label), c.paragraph(value)], factWidth, {
            borders: { top: hairline(INK, 8) },
            top: 140,
          }),
        ),
      }),
    ],
  );

  const partyCell = (label: string, value: InvoiceData['from'], blank: string) => [
    c.label(label),
    c.paragraph(c.value(value.name, blank, { bold: true })),
    ...(value.lines ?? [])
      .map(cleanText)
      .filter(Boolean)
      .map((line) => c.paragraph([c.run(line, { color: MUTED })])),
  ];
  const parties = table(
    [WIDTH / 2, WIDTH / 2],
    [
      new TableRow({
        children: [
          cell(partyCell('From', data.from, 'Your name'), WIDTH / 2),
          cell(partyCell('Bill to', data.billTo, 'Client name'), WIDTH / 2),
        ],
      }),
    ],
  );

  const columns = [WIDTH * 0.58, WIDTH * 0.12, WIDTH * 0.13, WIDTH * 0.17];
  const unit = totals.hourly ? 'Hours' : 'Qty';
  const head = new TableRow({
    tableHeader: true,
    children: ['Description', unit, 'Rate', 'Amount'].map((text, index) =>
      cell(
        [
          c.paragraph([c.run(text, { size: SIZE.small, color: MUTED })], {
            align: index ? right : undefined,
          }),
        ],
        columns[index],
        { borders: { bottom: hairline(INK, 6) }, bottom: 100 },
      ),
    ),
  });
  const rule = { borders: { bottom: hairline() }, top: 160, bottom: 160 };
  // Blank names must stay unique and short: a long or repeated title uses the line number.
  const lineName = (line: InvoiceLine, index: number) =>
    line.title.length <= 26 && totals.lines.filter((other) => other.title === line.title).length === 1
      ? line.title
      : `line ${index + 1}`;
  const itemRows = totals.lines.map((line, index) => {
    const name = lineName(line, index);
    // A known amount needs no blanks for the numbers that made it.
    const priced = line.amount !== undefined;
    const numberCell = (value: number | undefined, label: string, show: (n: number) => string, color = INK) =>
      c.paragraph(
        value !== undefined ? [c.run(show(value), { color })] : priced ? [c.run('')] : [c.blank(label)],
        { align: right },
      );
    return new TableRow({
      cantSplit: true,
      children: [
        cell(
          [
            c.paragraph([c.run(line.title, { bold: true })], { after: 40 }),
            c.paragraph(c.value(line.summary, `Summary: ${name}`, { size: SIZE.note }, { multiLine: true })),
          ],
          columns[0],
          rule,
        ),
        cell([numberCell(line.quantity, `${unit}: ${name}`, formatQuantity)], columns[1], rule),
        cell([numberCell(line.rate, `Rate: ${name}`, money, MUTED)], columns[2], rule),
        cell([numberCell(line.amount, `Amount: ${name}`, money)], columns[3], rule),
      ],
    });
  });
  const items = table(columns, [head, ...itemRows]);

  const totalsWidths = [WIDTH * 0.5, WIDTH * 0.22, WIDTH * 0.28];
  const totalRow = (label: string, value: ReturnType<TemplateCanvas['run']>[], strong = false) =>
    new TableRow({
      children: [
        cell([c.paragraph([c.run('')])], totalsWidths[0]),
        cell(
          [c.paragraph([c.run(label, { color: strong ? INK : MUTED, size: strong ? SIZE.body : 18 })])],
          totalsWidths[1],
          { top: strong ? 160 : 100, borders: strong ? { top: hairline(ACCENT, 8) } : {} },
        ),
        cell([c.paragraph(value, { align: right })], totalsWidths[2], {
          top: 100,
          borders: strong ? { top: hairline(ACCENT, 8) } : {},
        }),
      ],
    });
  const totalRows = [
    ...(totals.hours !== undefined
      ? [totalRow('Total hours', [c.run(formatQuantity(totals.hours), { color: MUTED, size: 18 })])]
      : []),
    ...(totals.total !== undefined
      ? [totalRow('Subtotal', [c.run(money(totals.total), { color: MUTED, size: 18 })])]
      : []),
    totalRow(
      `Total due (${currency})`,
      totals.total !== undefined
        ? [c.run(money(totals.total), { font: SERIF, size: SIZE.total })]
        : [c.blank('Total due', { font: SERIF, size: SIZE.total })],
      true,
    ),
  ];

  const engagement = cleanText(data.engagement);
  const notes = cleanText(data.notes);
  // A plain line with no separators: "Invoice INV-1042 from Mara Ellison".
  const footerText = [number ? `Invoice ${number}` : 'Invoice', fromName ? `from ${fromName}` : '']
    .filter(Boolean)
    .join(' ');
  return new Document({
    title,
    creator: fromName || 'Albatross',
    styles: houseStyles(),
    numbering: houseNumbering(),
    sections: [
      {
        properties: pageProperties(),
        footers: { default: new Footer({ children: [c.footer(footerText)] }) },
        children: [
          masthead,
          c.spacer(440),
          factRow,
          c.spacer(440),
          parties,
          c.spacer(360),
          ...(engagement ? [c.paragraph([c.run(engagement, { color: MUTED })], { after: 360 })] : []),
          items,
          c.spacer(120),
          table(totalsWidths, totalRows),
          c.spacer(600),
          table(
            [WIDTH / 2, WIDTH / 2],
            [
              new TableRow({
                cantSplit: true,
                children: [
                  cell(
                    [
                      c.label('Payment'),
                      c.paragraph(c.value(data.payment, 'Payment details', {}, { multiLine: true })),
                    ],
                    WIDTH / 2,
                  ),
                  cell(
                    notes
                      ? [c.label('Notes'), c.paragraph(c.lines(notes, { color: MUTED }))]
                      : [c.paragraph([c.run('')])],
                    WIDTH / 2,
                  ),
                ],
              }),
            ],
          ),
        ],
      },
    ],
  });
}

import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { OfficeError } from '../lib/documents/office-security';
import {
  DOCUMENT_TEMPLATES,
  renderTemplate,
  templateDataInputSchema,
  templateDataIssues,
} from '../lib/documents/templates';
import { blankSlug, cleanText, displayDate, TemplateCanvas } from '../lib/documents/templates/house';
import { formatMoney, formatQuantity, invoiceTotals } from '../lib/documents/templates/invoice';
import { isNumericCell } from '../lib/documents/templates/report';
import { readWordBlanks, readWordPackage } from '../lib/documents/word-package';
import {
  sampleInvoice,
  sampleLetter,
  sampleMemo,
  sampleReport,
} from '../scripts/fixtures/document-template-samples';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

async function part(bytes: Uint8Array, path: string) {
  const zip = await JSZip.loadAsync(bytes);
  return (await zip.file(path)?.async('string')) ?? '';
}
async function dom(bytes: Uint8Array, path = 'word/document.xml') {
  return new JSDOM(await part(bytes, path), { contentType: 'application/xml' }).window.document;
}
async function text(bytes: Uint8Array) {
  return (await readWordPackage(bytes)).paragraphs.map((paragraph) => paragraph.text).join('\n');
}
const samples = { invoice: sampleInvoice, letter: sampleLetter, memo: sampleMemo, report: sampleReport };

describe('Word templates', () => {
  test('each template renders a valid package in the house page, fonts, and footer', async () => {
    for (const template of DOCUMENT_TEMPLATES) {
      const { bytes } = await renderTemplate(template, samples[template], { title: `Sample ${template}` });
      const document = await part(bytes, 'word/document.xml');
      expect(document).toContain('<w:pgSz w:w="12240" w:h="15840"');
      expect(document).toMatch(/<w:pgMar w:top="1152" w:right="1152" w:bottom="1152" w:left="1152"/);
      const styles = await part(bytes, 'word/styles.xml');
      expect(styles).toContain('w:ascii="Geist"');
      expect(styles).toContain('<w:color w:val="1F1D1A"/>');
      expect(styles).toContain('w:styleId="Heading"');
      expect(await part(bytes, 'docProps/core.xml')).toContain(`Sample ${template}`);
      const footers = Object.keys((await JSZip.loadAsync(bytes)).files).filter((name) =>
        /^word\/footer\d+\.xml$/.test(name),
      );
      const footerXml = (await Promise.all(footers.map((name) => part(bytes, name)))).join('');
      expect(footerXml).toContain(' PAGE ');
      expect(footerXml).toContain(' NUMPAGES ');
      expect(document).not.toContain('[[lab86-');
    }
  });

  test('the invoice computes each amount and the totals from the items', async () => {
    const { bytes, blanks } = await renderTemplate('invoice', sampleInvoice, { title: 'Invoice INV-1042' });
    const body = await text(bytes);
    for (const value of ['Invoice', 'INV-1042', 'October 15, 2026', '$3,040.00', '$3,942.50', '$1,710.00'])
      expect(body).toContain(value);
    // Amount due and Total due. No adjustment, so no Subtotal row that repeats the total.
    expect(body.match(/\$8,692\.50/g)).toHaveLength(2);
    expect(body).not.toContain('Subtotal');
    expect(body).toContain('91.5');
    expect(body).toContain('Total due (USD)');
    expect(body).toContain('Hours');
    expect(blanks).toEqual(['Summary: August 2026', 'Payment details']);
    const document = await part(bytes, 'word/document.xml');
    expect(document).toContain('w:ascii="Fraunces Display"');
    expect(document).toContain('<w:sz w:val="64"/>');
    expect(document).toContain('<w:sz w:val="36"/>');
    // One restrained accent: the total rule. No brick accent and no tinted fill.
    expect(document.match(/<w:top w:val="single" w:color="216440" w:sz="8"\/>/g)).toHaveLength(2);
    expect(document).not.toContain('AE4B2B');
    expect(document).not.toContain('F6E9E3');
    expect(await part(bytes, 'word/footer1.xml')).toContain('Invoice INV-1042 from Mara Ellison');
    expect(body).toContain('Bill to');
    expect(body).toContain('Engagement');
    expect(body).not.toContain('From');
    expect(body.match(/Mara Ellison/g)).toHaveLength(1);
  });

  test('invoice numbers: a given amount wins, missing numbers become blanks, and the total waits for them', () => {
    const totals = invoiceTotals({
      ...sampleInvoice,
      items: [
        { title: 'Fixed fee', amount: 500 },
        { title: 'Rounding', quantity: 3, rate: 0.335 },
      ],
    });
    expect(totals.hourly).toBe(false);
    expect(totals.hours).toBeUndefined();
    expect(totals.lines.map((line) => line.amount)).toEqual([500, 1.01]);
    expect(totals.total).toBe(501.01);
    const open = invoiceTotals({
      ...sampleInvoice,
      items: [
        { title: 'July', hours: 10, rate: 50 },
        { title: 'August', rate: 50 },
      ],
    });
    expect(open.total).toBeUndefined();
    expect(open.hours).toBeUndefined();
    expect(open.lines[1].amount).toBeUndefined();
    expect(totals.adjustments).toEqual([]);
    expect(totals.subtotal).toBe(501.01);
    const adjusted = invoiceTotals({
      ...sampleInvoice,
      items: [{ title: 'Work', hours: 10, rate: 100 }],
      adjustments: [
        { label: 'Tax', percent: 8 },
        { label: 'Credit', amount: -50 },
      ],
    });
    expect(adjusted).toMatchObject({ subtotal: 1000, total: 1030, hours: 10 });
    expect(adjusted.adjustments).toEqual([
      { label: 'Tax', amount: 80 },
      { label: 'Credit', amount: -50 },
    ]);
    // A percent needs a known subtotal; without it the total stays open.
    const unknown = invoiceTotals({
      ...sampleInvoice,
      items: [{ title: 'Work', rate: 100 }],
      adjustments: [{ label: 'Tax', percent: 8 }],
    });
    expect(unknown.subtotal).toBeUndefined();
    expect(unknown.adjustments[0].amount).toBeUndefined();
    expect(unknown.total).toBeUndefined();
  });

  test('an adjustment brings back the Subtotal row and changes the total', async () => {
    const { bytes, blanks } = await renderTemplate('invoice', {
      ...sampleInvoice,
      adjustments: [
        { label: 'Sales tax 6.25%', percent: 6.25 },
        { label: 'Returning client discount', amount: -100 },
      ],
    });
    const body = await text(bytes);
    expect(body).toContain('Subtotal');
    expect(body).toContain('$8,692.50');
    expect(body).toContain('Sales tax 6.25%');
    expect(body).toContain('$543.28');
    expect(body).toContain('-$100.00');
    expect(body.match(/\$9,135\.78/g)).toHaveLength(2);
    expect(blanks).toEqual(['Summary: August 2026', 'Payment details']);
    const open = await renderTemplate('invoice', { ...sampleInvoice, adjustments: [{ label: 'Shipping' }] });
    expect(open.blanks).toEqual(['Total due', 'Summary: August 2026', 'Amount: Shipping', 'Payment details']);
    expect(await text(open.bytes)).toContain('Subtotal');
  });

  test('an invoice with unknown quantities shows blanks and one shared total blank', async () => {
    const { bytes, blanks } = await renderTemplate('invoice', {
      from: {},
      billTo: { name: 'Northwind Clinic' },
      items: [
        { title: 'July 2026', summary: 'Intake form work.', rate: 95 },
        { title: 'A very long line item title for the August work', summary: 'Booking flow.', quantity: 2 },
        { title: 'Retainer', summary: 'Monthly retainer.', amount: 400 },
      ],
      currency: 'eur',
      payment: 'Bank transfer within 30 days.',
    });
    expect(blanks).toEqual([
      'Your name',
      'Invoice number',
      'Invoice date',
      'Total due',
      'Qty: July 2026',
      'Amount: July 2026',
      'Rate: line 2',
      'Amount: line 2',
    ]);
    const document = await dom(bytes);
    const tags = Array.from(document.getElementsByTagNameNS(W, 'tag')).map((tag) =>
      tag.getAttributeNS(W, 'val'),
    );
    expect(tags.filter((tag) => tag === 'blank:total-due')).toHaveLength(2);
    // The masthead is the only place for the sender.
    expect(tags.filter((tag) => tag === 'blank:your-name')).toHaveLength(1);
    const body = await text(bytes);
    expect(body).toContain('€400.00');
    expect(body).toContain('Total due (EUR)');
    expect(body).not.toContain('Subtotal');
    expect(body).not.toContain('Total hours');
    expect(body).not.toContain('Service period');
  });

  test('a letter fills its defaults and makes blanks for what is missing', async () => {
    const full = await renderTemplate('letter', sampleLetter);
    const body = await text(full.bytes);
    expect(body).toContain('Dear Dr. Lena Ortiz,');
    expect(body).toContain('Kind regards,');
    expect(body).toContain('Principal, Ellison Design Studio');
    expect(full.blanks).toEqual([]);
    const settings = await part(full.bytes, 'word/document.xml');
    expect(settings).toContain('<w:titlePg/>');
    const numbering = await part(full.bytes, 'word/numbering.xml');
    expect(numbering).toContain('w:val="•"');
    const sparse = await renderTemplate('letter', { from: {}, to: {}, body: ['Short note.'] });
    expect(sparse.blanks).toEqual(['Your name', 'Date', 'Recipient name', 'Salutation']);
    expect(await text(sparse.bytes)).toContain('Sincerely,');
  });

  test('a memo and a report render their blocks, bullets, headings, and right-aligned numbers', async () => {
    const memo = await renderTemplate('memo', { body: ['- One', '- Two', 'After the list.'] });
    expect(memo.blanks).toEqual(['To', 'From', 'Date', 'Subject']);
    const memoBody = await dom(memo.bytes);
    expect(memoBody.getElementsByTagNameNS(W, 'numPr')).toHaveLength(2);
    const report = await renderTemplate('report', sampleReport);
    expect(report.blanks).toEqual(['Date']);
    const reportXml = await dom(report.bytes);
    const headings = Array.from(reportXml.getElementsByTagNameNS(W, 'pStyle')).filter(
      (style) => style.getAttributeNS(W, 'val') === 'Heading1',
    );
    expect(headings).toHaveLength(3);
    const cells = Array.from(reportXml.getElementsByTagNameNS(W, 'tc'));
    const alignOf = (value: string) =>
      cells
        .find((cell) => cell.textContent === value)
        ?.getElementsByTagNameNS(W, 'jc')[0]
        ?.getAttributeNS(W, 'val');
    expect(alignOf('412')).toBe('right');
    expect(alignOf('58.9%')).toBe('right');
    expect(alignOf('July')).toBeUndefined();
    expect(await text(report.bytes)).toContain('Source: clinic booking system export of October 2, 2026.');
  });

  test('the model cannot style a template: unknown keys such as fonts and colors are ignored', async () => {
    const { bytes } = await renderTemplate('memo', {
      ...sampleMemo,
      font: 'Comic Sans MS',
      color: 'FF00FF',
      body: ['Plain text.'],
    });
    const xml = (await part(bytes, 'word/document.xml')) + (await part(bytes, 'word/styles.xml'));
    expect(xml).not.toContain('Comic Sans');
    expect(xml).not.toContain('FF00FF');
  });

  test('invalid data fails with the field path and nothing renders', async () => {
    await expect(renderTemplate('invoice', { from: {}, billTo: {}, items: [] })).rejects.toThrow(
      'items: Too small',
    );
    await expect(renderTemplate('invoice', {})).rejects.toBeInstanceOf(OfficeError);
    await expect(renderTemplate('nope' as never, {})).rejects.toThrow('Unknown template');
    expect(templateDataIssues('memo', sampleMemo)).toEqual([]);
    expect(templateDataIssues('memo', { body: [] }).map((issue) => issue.path.join('.'))).toEqual(['body']);
  });

  test('the model-facing data union keeps every key of the matched template', () => {
    for (const template of DOCUMENT_TEMPLATES) {
      const parsed = templateDataInputSchema.parse(samples[template]);
      expect(parsed).toEqual(samples[template] as never);
    }
  });

  test('blank names read back in page order with no value', async () => {
    const { bytes } = await renderTemplate('report', sampleReport);
    expect(await readWordBlanks(bytes)).toEqual([{ name: 'Date', slug: 'date', value: '', filled: false }]);
  });
});

describe('template helpers', () => {
  test('money, quantity, and dates format for an official document', () => {
    expect(formatMoney(1234.5)).toBe('$1,234.50');
    expect(formatMoney(-20, 'eur')).toBe('-€20.00');
    expect(formatMoney(10, 'ZZ!')).toBe('10.00 ZZ!');
    expect(formatQuantity(41.5)).toBe('41.5');
    expect(formatQuantity(1 / 3)).toBe('0.33');
    expect(displayDate('2026-10-15')).toBe('October 15, 2026');
    expect(displayDate('2026-02-30')).toBe('2026-02-30');
    expect(displayDate('Oct 15')).toBe('Oct 15');
  });

  test('blank slugs, text cleaning, and numeric cells', () => {
    expect(blankSlug('Summary: Août 2026')).toBe('summary-aout-2026');
    expect(blankSlug('***')).toBe('blank');
    expect(blankSlug('x'.repeat(80))).toHaveLength(60);
    expect(cleanText('  a\u0000b\u0007c\r\nd￾  ')).toBe('abc\nd');
    expect(cleanText(undefined)).toBe('');
    for (const value of ['412', '58.9%', '$1,200', '(300)', '-4.5', '12k'])
      expect(isNumericCell(value)).toBe(true);
    for (const value of ['July', '', 'n/a', '12 apples']) expect(isNumericCell(value)).toBe(false);
  });

  test('the canvas reuses a blank for the same label and keeps markers unique for each render', () => {
    const canvas = new TemplateCanvas();
    canvas.blank('Total due');
    canvas.blank('Total due');
    canvas.blank('   ');
    expect(canvas.blanks.map((blank) => blank.label)).toEqual(['Total due', 'Blank']);
    expect(canvas.markerPattern().test(canvas.marker('blank', '0'))).toBe(true);
    expect(new TemplateCanvas().markerPattern().test(canvas.marker('blank', '0'))).toBe(false);
  });
});

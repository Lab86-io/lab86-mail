import { describe, expect, test } from 'bun:test';
import { Packer, Paragraph, Document as WordDocument } from 'docx';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { renderTemplate } from '../lib/documents/templates';
import { BlankNotFoundError, fillBlank, readBlanks, wrapBlankRun } from '../lib/documents/templates/blanks';
import {
  embedTemplateFonts,
  loadTemplateFont,
  obfuscateFont,
  TEMPLATE_FONTS,
} from '../lib/documents/templates/fonts';
import { replaceWithFieldRuns } from '../lib/documents/templates/package';
import { editWordPackage, readWordBlanks, readWordPackage } from '../lib/documents/word-package';
import { sampleInvoice, sampleMemo } from '../scripts/fixtures/document-template-samples';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

async function part(bytes: Uint8Array, path: string) {
  return (await (await JSZip.loadAsync(bytes)).file(path)?.async('string')) ?? '';
}
function xml(source: string) {
  return new JSDOM(source, { contentType: 'application/xml' }).window.document;
}
const w = (doc: Document | Element, name: string) => Array.from(doc.getElementsByTagNameNS(W, name));
const attr = (node: Element | undefined, name: string) => node?.getAttributeNS(W, name) ?? null;

/** A paragraph that holds one run styled as the template would style a field. */
function runDocument() {
  return xml(
    `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:rPr><w:rFonts w:ascii="Geist" w:hAnsi="Geist"/><w:color w:val="1F1D1A"/><w:sz w:val="19"/></w:rPr><w:t>marker</w:t></w:r></w:p></w:body></w:document>`,
  );
}

describe('embedded template fonts', () => {
  test('the package holds an obfuscated regular and bold Geist and a regular Fraunces Display', async () => {
    const { bytes } = await renderTemplate('memo', sampleMemo);
    const zip = await JSZip.loadAsync(bytes);
    const table = xml(await zip.file('word/fontTable.xml')!.async('string'));
    const rels = xml(await zip.file('word/_rels/fontTable.xml.rels')!.async('string'));
    const targets = new Map(
      Array.from(rels.documentElement.children).map((rel) => [
        rel.getAttribute('Id'),
        rel.getAttribute('Target'),
      ]),
    );
    const fonts = w(table, 'font');
    expect(fonts.map((font) => attr(font, 'name'))).toEqual(['Geist', 'Fraunces Display']);
    const expected: Record<string, Record<string, string>> = {
      Geist: { embedRegular: 'Geist-Regular.ttf', embedBold: 'Geist-Bold.ttf' },
      'Fraunces Display': { embedRegular: 'FrauncesDisplay-Regular.ttf' },
    };
    for (const font of fonts) {
      const faces = expected[attr(font, 'name')!];
      const embeds = Array.from(font.children).filter((child) => child.localName.startsWith('embed'));
      expect(embeds.map((embed) => embed.localName)).toEqual(Object.keys(faces));
      for (const embed of embeds) {
        const key = attr(embed, 'fontKey')!.replace(/[{}]/g, '');
        const target = targets.get(embed.getAttributeNS(R, 'id'))!;
        const stored = await zip.file(`word/${target}`)!.async('uint8array');
        const original = await loadTemplateFont(faces[embed.localName]);
        expect(stored.length).toBe(original.length);
        expect(Buffer.from(stored.subarray(0, 32)).equals(Buffer.from(original.subarray(0, 32)))).toBe(false);
        expect(Buffer.from(obfuscateFont(stored, key)).equals(Buffer.from(original))).toBe(true);
      }
    }
    expect(await zip.file('[Content_Types].xml')!.async('string')).toContain('Extension="odttf"');
    expect(await zip.file('word/_rels/document.xml.rels')!.async('string')).toContain(
      'relationships/fontTable',
    );
    const settings = await zip.file('word/settings.xml')!.async('string');
    expect(settings).toContain('<w:displayBackgroundShape/><w:embedTrueTypeFonts/>');
    expect(settings.match(/embedTrueTypeFonts/g)).toHaveLength(1);
  });

  test('obfuscation matches the docx library for the same key', async () => {
    const font = await loadTemplateFont(TEMPLATE_FONTS[1].faces.regular!);
    const zip = await JSZip.loadAsync(
      await Packer.toBuffer(
        new WordDocument({
          fonts: [{ name: 'Fraunces Display', data: Buffer.from(font) }],
          sections: [{ children: [new Paragraph('x')] }],
        }),
      ),
    );
    const key = /w:fontKey="\{([^}]+)\}"/.exec(await zip.file('word/fontTable.xml')!.async('string'))![1];
    const reference = await zip.file('word/fonts/font1.odttf')!.async('uint8array');
    expect(Buffer.from(obfuscateFont(font, key)).equals(Buffer.from(reference))).toBe(true);
    expect(() => obfuscateFont(font, 'not-a-guid')).toThrow('GUID');
  });

  test('a bare package gets the content type, the font table link, and the setting', async () => {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
    );
    zip.file('word/_rels/document.xml.rels', '<Relationships></Relationships>');
    zip.file('word/settings.xml', `<w:settings xmlns:w="${W}"><w:zoom w:percent="100"/></w:settings>`);
    let next = 0;
    await embedTemplateFonts(zip, {
      families: [{ name: 'Geist', kind: 'swiss', faces: { regular: 'Geist-Regular.ttf' } }],
      newKey: () => `00000000-0000-0000-0000-00000000000${next++}`,
    });
    const types = await zip.file('[Content_Types].xml')!.async('string');
    expect(types).toContain('Extension="odttf"');
    expect(types).toContain('PartName="/word/fontTable.xml"');
    expect(await zip.file('word/_rels/document.xml.rels')!.async('string')).toContain(
      'Target="fontTable.xml"',
    );
    expect(await zip.file('word/settings.xml')!.async('string')).toContain(
      '<w:zoom w:percent="100"/><w:embedTrueTypeFonts/>',
    );
    expect(await zip.file('word/fontTable.xml')!.async('string')).toContain(
      'w:fontKey="{00000000-0000-0000-0000-000000000000}"',
    );
    expect(zip.file('word/fonts/geist-regular.odttf')).toBeTruthy();
    // No settings part at all, and settings with no earlier element: both are safe.
    const empty = new JSZip();
    empty.file('word/settings.xml', `<w:settings xmlns:w="${W}"><w:compat/></w:settings>`);
    await embedTemplateFonts(empty, { families: [] });
    expect(await empty.file('word/settings.xml')!.async('string')).toContain(
      `<w:settings xmlns:w="${W}"><w:embedTrueTypeFonts/><w:compat/>`,
    );
    await embedTemplateFonts(new JSZip(), { families: [] });
  });

  test('a missing font file fails and can be loaded again later', async () => {
    await expect(loadTemplateFont('Missing.ttf')).rejects.toThrow();
    await expect(loadTemplateFont('Missing.ttf')).rejects.toThrow();
  });
});

describe('blanks as content controls', () => {
  test('a blank is an inline content control with its tag, label, and accent placeholder', async () => {
    const { bytes } = await renderTemplate('invoice', sampleInvoice);
    const document = xml(await part(bytes, 'word/document.xml'));
    const sdt = w(document, 'sdt').find(
      (node) => attr(w(node, 'tag')[0], 'val') === 'blank:payment-details',
    )!;
    const sdtPr = w(sdt, 'sdtPr')[0];
    expect(Array.from(sdtPr.children).map((child) => child.localName)).toEqual([
      'rPr',
      'alias',
      'tag',
      'id',
      'showingPlcHdr',
      'text',
    ]);
    expect(attr(w(sdtPr, 'alias')[0], 'val')).toBe('Payment details');
    expect(attr(w(sdtPr, 'text')[0], 'multiLine')).toBe('1');
    expect(attr(w(w(sdtPr, 'rPr')[0], 'color')[0], 'val')).toBe('1F1D1A');
    expect(w(w(sdtPr, 'rPr')[0], 'shd')).toHaveLength(0);
    expect(w(w(sdtPr, 'rPr')[0], 'u')).toHaveLength(0);
    const content = w(sdt, 'sdtContent')[0];
    // An empty underlined slot: the muted label on an accent underline, with no fill.
    expect(content.textContent).toBe(`Payment details${'\u00a0'.repeat(6)}`);
    expect(attr(w(content, 'color')[0], 'val')).toBe('6B665D');
    expect(attr(w(content, 'u')[0], 'val')).toBe('single');
    expect(attr(w(content, 'u')[0], 'color')).toBe('216440');
    expect(w(content, 'shd')).toHaveLength(0);
    expect(sdt.parentElement?.localName).toBe('p');
    const ids = w(document, 'sdt').map((node) => attr(w(node, 'id')[0], 'val'));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('fill_blank writes a value in the body style and reads back; an empty value shows the blank again', async () => {
    const { bytes } = await renderTemplate('invoice', sampleInvoice);
    const filled = await editWordPackage(bytes, [
      {
        op: 'fill_blank',
        blank: 'payment details',
        value: 'Bank transfer within 30 days.\nReference INV-1042.',
      },
      { op: 'fill_blank', blank: 'blank:summary-august-2026', value: 'Booking flow build.' },
    ]);
    expect(await readWordBlanks(filled)).toEqual([
      {
        name: 'Summary: August 2026',
        slug: 'summary-august-2026',
        value: 'Booking flow build.',
        filled: true,
      },
      {
        name: 'Payment details',
        slug: 'payment-details',
        value: 'Bank transfer within 30 days.\nReference INV-1042.',
        filled: true,
      },
    ]);
    const read = await readWordPackage(filled);
    expect(read.blanks).toEqual([
      { name: 'Summary: August 2026', value: 'Booking flow build.', filled: true },
      { name: 'Payment details', value: 'Bank transfer within 30 days.\nReference INV-1042.', filled: true },
    ]);
    const document = xml(await part(filled, 'word/document.xml'));
    const payment = w(document, 'sdt').find(
      (node) => attr(w(node, 'tag')[0], 'val') === 'blank:payment-details',
    )!;
    expect(w(payment, 'showingPlcHdr')).toHaveLength(0);
    const run = w(w(payment, 'sdtContent')[0], 'r')[0];
    expect(attr(w(run, 'color')[0], 'val')).toBe('1F1D1A');
    expect(w(run, 'shd')).toHaveLength(0);
    expect(w(run, 'u')).toHaveLength(0);
    expect(w(run, 'br')).toHaveLength(1);

    const cleared = await editWordPackage(filled, [
      { op: 'fill_blank', blank: 'Payment details', value: ' ' },
    ]);
    expect((await readWordBlanks(cleared))[1]).toEqual({
      name: 'Payment details',
      slug: 'payment-details',
      value: '',
      filled: false,
    });
    const clearedXml = xml(await part(cleared, 'word/document.xml'));
    const again = w(clearedXml, 'sdt').find(
      (node) => attr(w(node, 'tag')[0], 'val') === 'blank:payment-details',
    )!;
    expect(Array.from(w(again, 'sdtPr')[0].children).map((child) => child.localName)).toEqual([
      'rPr',
      'alias',
      'tag',
      'id',
      'showingPlcHdr',
      'text',
    ]);
    expect(attr(w(w(again, 'sdtContent')[0], 'color')[0], 'val')).toBe('6B665D');
    expect(attr(w(w(again, 'sdtContent')[0], 'u')[0], 'color')).toBe('216440');
  });

  test('one blank in two places fills both; an unknown blank names the real ones and saves nothing', async () => {
    const { bytes } = await renderTemplate('invoice', {
      from: { name: 'Mara Ellison' },
      billTo: { name: 'Northwind Clinic' },
      number: 'INV-7',
      issued: '2026-10-15',
      payment: 'On receipt.',
      items: [{ title: 'Review', summary: 'Two sessions.', rate: 100 }],
    });
    const filled = await editWordPackage(bytes, [
      { op: 'fill_blank', blank: 'Total due', value: '$400.00' },
      { op: 'fill_blank', blank: 'Qty: Review', value: '4' },
      { op: 'fill_blank', blank: 'Amount: Review', value: '$400.00' },
    ]);
    expect((await readWordBlanks(filled)).every((blank) => blank.filled)).toBe(true);
    expect((await readWordPackage(filled)).paragraphs.filter((p) => p.text === '$400.00')).toHaveLength(3);
    await expect(
      editWordPackage(bytes, [{ op: 'fill_blank', blank: 'Due date', value: 'x' }]),
    ).rejects.toThrow(
      'No blank is named "Due date". The blanks are "Total due", "Qty: Review", "Amount: Review".',
    );
    const plain = await Packer.toBuffer(new WordDocument({ sections: [{ children: [new Paragraph('x')] }] }));
    await expect(editWordPackage(plain, [{ op: 'fill_blank', blank: 'Any', value: 'x' }])).rejects.toThrow(
      'This document has no blanks.',
    );
  });

  test('controls saved by another editor still read and fill: block level, no placeholder flag, label as text', () => {
    const doc = xml(
      `<w:document xmlns:w="${W}"><w:body>
        <w:sdt><w:sdtPr><w:alias w:val="Notes"/><w:tag w:val="blank:notes"/></w:sdtPr>
          <w:sdtContent><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>Notes</w:t></w:r></w:p><w:p><w:r><w:t>more</w:t></w:r></w:p></w:sdtContent></w:sdt>
        <w:p><w:sdt><w:sdtPr><w:tag w:val="other"/></w:sdtPr><w:sdtContent><w:r><w:t>Other</w:t></w:r></w:sdtContent></w:sdt></w:p>
        <w:p><w:sdt><w:sdtPr><w:tag w:val="blank:city"/></w:sdtPr><w:sdtContent><w:r><w:t>Salem</w:t><w:tab/><w:t>MA</w:t></w:r></w:sdtContent></w:sdt></w:p>
      </w:body></w:document>`,
    );
    expect(readBlanks(doc)).toEqual([
      { name: 'Notes', slug: 'notes', value: 'Notes\nmore', filled: true },
      { name: 'city', slug: 'city', value: 'Salem\tMA', filled: true },
    ]);
    expect(fillBlank(doc, 'NOTES', 'Paid in full.')).toBe('Notes');
    const content = w(doc, 'sdtContent')[0];
    expect(w(content, 'p')).toHaveLength(1);
    expect(attr(w(content, 'jc')[0], 'val')).toBe('right');
    expect(content.textContent).toBe('Paid in full.');
    // No stored style: the filled value is ink, not the muted label color.
    expect(attr(w(content, 'color')[0], 'val')).toBe('1F1D1A');
    expect(readBlanks(doc)[0]).toMatchObject({ value: 'Paid in full.', filled: true });
    expect(() => fillBlank(doc, 'Missing', 'x')).toThrow(BlankNotFoundError);
  });

  test('a label kept as text without the placeholder flag reads as empty', () => {
    const doc = runDocument();
    wrapBlankRun(w(doc, 'r')[0], { label: 'Invoice date', slug: 'invoice-date', multiLine: false }, 9);
    w(doc, 'showingPlcHdr')[0].remove();
    w(doc, 't')[0].textContent = 'Invoice date';
    expect(readBlanks(doc)).toEqual([
      { name: 'Invoice date', slug: 'invoice-date', value: '', filled: false },
    ]);
    expect(attr(w(doc, 'text')[0], 'multiLine')).toBeNull();
  });
});

describe('page number fields', () => {
  test('each field is five runs, and every run keeps the footer size', async () => {
    const { bytes } = await renderTemplate('memo', sampleMemo);
    const zip = await JSZip.loadAsync(bytes);
    const footers = Object.keys(zip.files).filter((name) => /^word\/footer\d+\.xml$/.test(name));
    const footer = xml((await Promise.all(footers.map((name) => zip.file(name)!.async('string')))).join(''));
    const runs = w(footer, 'r');
    const fieldRuns = runs.filter((run) => w(run, 'fldChar').length || w(run, 'instrText').length);
    expect(fieldRuns).toHaveLength(8);
    for (const run of runs) {
      expect(w(run, 'fldChar').length + w(run, 'instrText').length).toBeLessThanOrEqual(1);
      expect(attr(w(run, 'sz')[0], 'val')).toBe('15');
    }
    const sequence = runs
      .map((run) =>
        w(run, 'fldChar')[0]
          ? attr(w(run, 'fldChar')[0], 'fldCharType')
          : w(run, 'instrText')[0]
            ? w(run, 'instrText')[0].textContent
            : w(run, 't')[0]?.textContent,
      )
      .filter((value) => value !== undefined && value !== '' && value !== ' of ' && value !== 'Page ');
    expect(sequence).toEqual([
      'New check-in process from November 3',
      'begin',
      ' PAGE ',
      'separate',
      '1',
      'end',
      'begin',
      ' NUMPAGES ',
      'separate',
      '1',
      'end',
    ]);
  });

  test('a field run with no properties still splits into five runs', () => {
    const doc = xml(`<w:p xmlns:w="${W}"><w:r><w:t>x</w:t></w:r></w:p>`);
    replaceWithFieldRuns(w(doc, 'r')[0], 'PAGE');
    expect(w(doc, 'r')).toHaveLength(5);
    expect(w(doc, 'rPr')).toHaveLength(0);
  });
});

import { describe, expect, test } from 'bun:test';
import { Document, ExternalHyperlink, Footer, Header, Packer, Paragraph, TextRun } from 'docx';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import {
  createWordPackage,
  editWordPackage,
  readWordPackage,
  wordEditsSchema,
} from '../lib/documents/word-package';

import { fullWordEdits, png } from '../scripts/fixtures/word-suite-plan';

describe('full Word DOCX packages', () => {
  test('creates rich content, tables, images, comments, headers, footers and page layout that survive reopening', async () => {
    const bytes = await createWordPackage('Quarterly update', fullWordEdits);
    const result = await readWordPackage(bytes);
    expect(result.paragraphs[1]).toMatchObject({
      text: 'Quarterly update',
      style: 'Heading1',
      inTable: false,
    });
    expect(result.paragraphs[3]).toMatchObject({ text: 'Month', inTable: true });
    expect(result.tables).toBe(1);
    expect(result.images).toBe(1);
    expect(result.notes.map((note) => note.text)).toEqual(
      expect.arrayContaining(['Lab86 · Quarterly report', 'Internal review', 'Confirm the final figures.']),
    );
    const zip = await JSZip.loadAsync(bytes);
    const body = await zip.file('word/document.xml')!.async('string');
    expect(body).toContain('w:w="16838"');
    expect(body).toContain('w:h="11906"');
    expect(body).toContain('w:top="1080"');
    expect(body).toContain('w:val="yellow"');
    expect(body).toContain('w:val="28"');
    expect(body).toContain('commentRangeStart');
    expect(body).toContain('tblHeader');
    expect(body).toContain('w:line="360"');
    const edited = await editWordPackage(bytes, [
      { op: 'replace_text', paragraph: 2, find: '$20', replacement: '$24' },
    ]);
    expect((await readWordPackage(edited)).paragraphs[2].text).toBe('Revenue grew from $10 to $24.');
    const after = await JSZip.loadAsync(edited);
    for (const [path, file] of Object.entries(zip.files)) {
      if (file.dir || path === 'word/document.xml') continue;
      expect(await after.file(path)!.async('uint8array')).toEqual(await file.async('uint8array'));
    }
  });

  test('replacement spans formatted runs, preserves links and existing Office-only parts, and replaces all occurrences from the end', async () => {
    const bytes = await Packer.toBuffer(
      new Document({
        sections: [
          {
            headers: { default: new Header({ children: [new Paragraph('Existing header')] }) },
            footers: { default: new Footer({ children: [new Paragraph('Existing footer')] }) },
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: 'Hello ', bold: true }),
                  new TextRun({ text: 'world Hello world', italics: true }),
                  new ExternalHyperlink({ link: 'https://example.com', children: [new TextRun(' source')] }),
                ],
              }),
            ],
          },
        ],
      }),
    );
    const result = await editWordPackage(bytes, [
      { op: 'replace_text', paragraph: 0, find: 'Hello world', replacement: 'Hi & welcome', all: true },
    ]);
    expect((await readWordPackage(result)).paragraphs[0].text).toBe('Hi & welcome Hi & welcome source');
    const original = await JSZip.loadAsync(bytes);
    const edited = await JSZip.loadAsync(result);
    expect(await edited.file('word/document.xml')!.async('string')).toContain('hyperlink');
    for (const [path, file] of Object.entries(original.files))
      if (!file.dir && path !== 'word/document.xml')
        expect(await edited.file(path)!.async('uint8array')).toEqual(await file.async('uint8array'));
  });

  test('line breaks and tabs are visible and cannot accidentally match across a structural boundary', async () => {
    const bytes = await createWordPackage('Breaks', [
      { op: 'insert_paragraph', text: 'first\nsecond\tthird' },
    ]);
    expect((await readWordPackage(bytes)).paragraphs[1].text).toBe('first\nsecond\tthird');
    await expect(
      editWordPackage(bytes, [
        { op: 'replace_text', paragraph: 1, find: 'firstsecond', replacement: 'wrong' },
      ]),
    ).rejects.toThrow('not found');
    const updated = await editWordPackage(bytes, [
      { op: 'replace_text', paragraph: 1, find: 'second', replacement: 'middle' },
    ]);
    expect((await readWordPackage(updated)).paragraphs[1].text).toBe('first\nmiddle\tthird');
  });

  test('rejects invalid batches atomically, unsafe XML, invalid images, and unsupported targets', async () => {
    const bytes = await createWordPackage('Atomic', [{ op: 'insert_paragraph', text: 'Original' }]);
    const before = Buffer.from(bytes);
    await expect(
      editWordPackage(bytes, [
        { op: 'replace_text', paragraph: 1, find: 'Original', replacement: 'New' },
        { op: 'format_text', paragraphs: [500], bold: true },
      ]),
    ).rejects.toThrow('does not exist');
    expect(Buffer.from(bytes)).toEqual(before);
    await expect(editWordPackage(bytes, [{ op: 'insert_table', rows: [['A'], ['B', 'C']] }])).rejects.toThrow(
      'same number',
    );
    await expect(
      editWordPackage(bytes, [
        { op: 'insert_image', dataUrl: 'data:image/png;base64,YWJj', width: 10, height: 10 },
      ]),
    ).rejects.toThrow('PNG or JPEG');
    await expect(
      editWordPackage(bytes, [
        { op: 'insert_image', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 10, height: 10 },
      ]),
    ).rejects.toThrow('could not be decoded');
    expect(
      wordEditsSchema.safeParse([{ op: 'format_text', paragraphs: [0], color: 'red;url(evil)' }]).success,
    ).toBe(false);
    expect(wordEditsSchema.safeParse([]).success).toBe(false);
    const zip = await JSZip.loadAsync(bytes);
    zip.file('word/document.xml', '<!DOCTYPE a [<!ENTITY b "bad">]><a/>');
    await expect(readWordPackage(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('safely');
  });

  test('can restyle text, reset headings, update margins without discarding existing page properties, and preserve images through another image insertion', async () => {
    let bytes = await createWordPackage('Styles', fullWordEdits);
    bytes = await editWordPackage(bytes, [
      { op: 'format_text', paragraphs: [2], bold: false, italic: false, underline: false, highlight: 'none' },
      { op: 'format_paragraph', paragraphs: [1], heading: 0, pageBreakBefore: true, alignment: 'right' },
      { op: 'page_setup', landscape: false },
      { op: 'insert_image', dataUrl: png, width: 24, height: 24 },
      { op: 'add_comment', paragraph: 2, text: 'Second comment' },
    ]);
    const zip = await JSZip.loadAsync(bytes);
    const source = await zip.file('word/document.xml')!.async('string');
    const dom = new JSDOM(source, { contentType: 'application/xml' });
    try {
      const ids = Array.from(dom.window.document.getElementsByTagName('*'))
        .filter((node) => node.localName === 'docPr')
        .map((node) => node.getAttribute('id'));
      expect(new Set(ids).size).toBe(2);
    } finally {
      dom.window.close();
    }
    expect(source).toContain('w:w="11906"');
    expect(source).toContain('w:top="1080"');
    expect(source).toContain('w:val="Normal"');
    expect(
      (await readWordPackage(bytes)).notes.find((note) => note.part.endsWith('comments.xml'))?.text,
    ).toContain('Second comment');
  });
});

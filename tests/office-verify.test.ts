import { afterEach, describe, expect, mock, test } from 'bun:test';
import JSZip from 'jszip';
import { referenceDeck } from '../lib/documents/deck-fixtures';
import { exportDocument } from '../lib/documents/export';
import type { AlbatrossDocumentModel, AlbatrossDocumentRecord } from '../lib/documents/model';
import { OfficeError } from '../lib/documents/office-security';
import { parseStrictXml, verifyOfficePackage } from '../lib/documents/office-verify';
import { renderTemplate } from '../lib/documents/templates';
import { createWordPackage, editWordPackage, readWordPackage } from '../lib/documents/word-package';
import { xmlSafeDeep, xmlSafeText } from '../lib/documents/xml-text';
import { __setDocumentToolDepsForTest, documentCreate } from '../lib/tools/documents';
import { invokeTool } from '../lib/tools/registry';
import { toolContext } from './tools/harness';

// Each file here is real: the real renderer makes it, and the strict parser opens it again.
const CONTROL = 'Pay\u000c by\u0001 Friday\u000b￿';
const CLEAN = 'Pay by Friday';

function record(kind: AlbatrossDocumentRecord['kind'], model: AlbatrossDocumentModel) {
  return {
    documentId: 'file',
    title: `Plan${'\u000c'}`,
    kind,
    model,
    currentRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    sourceRefs: [],
  } as AlbatrossDocumentRecord;
}

async function replacePart(bytes: Uint8Array, part: string, content: string) {
  const zip = await JSZip.loadAsync(bytes);
  zip.file(part, content);
  return zip.generateAsync({ type: 'uint8array' });
}

async function expectEveryPartParses(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((name) => /\.(?:xml|rels)$/.test(name));
  expect(names.length).toBeGreaterThan(3);
  for (const name of names)
    expect(parseStrictXml(await zip.file(name)!.async('string'))).toHaveProperty('root');
}

afterEach(() => __setDocumentToolDepsForTest());

describe('safe text', () => {
  test('removes what XML 1.0 forbids and keeps tabs, line breaks, and astral text', () => {
    expect(xmlSafeText(CONTROL)).toBe(CLEAN);
    expect(xmlSafeText('a\tb\nc\r\u{1F600}')).toBe('a\tb\nc\r\u{1F600}');
    expect(xmlSafeText('lone \ud800 surrogate')).toBe('lone  surrogate');
    expect(xmlSafeDeep({ a: [`x${'\u0002'}`], b: { c: 1, d: null } })).toEqual({
      a: ['x'],
      b: { c: 1, d: null },
    });
  });
});

describe('the strict parser', () => {
  test('refuses a control character, an open tag, an unbound prefix, and a document type', () => {
    expect(parseStrictXml('<a>ok</a>')).toEqual({ root: 'a' });
    expect(parseStrictXml('<a>x\u000cy</a>')).toHaveProperty('error');
    expect(parseStrictXml('<a><b></a>')).toHaveProperty('error');
    expect(parseStrictXml('<w:a/>')).toHaveProperty('error');
    expect(parseStrictXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')).toHaveProperty('error');
  });
});

describe('verifyOfficePackage', () => {
  test('a good file opens; each kind of damage is a clear failure', async () => {
    const good = await createWordPackage('Report', [{ op: 'insert_paragraph', text: 'Body' }]);
    await verifyOfficePackage(good, 'docx');
    const refused = async (bytes: Uint8Array) =>
      verifyOfficePackage(bytes, 'docx').then(
        () => '',
        (error) => {
          expect(error).toBeInstanceOf(OfficeError);
          return String(error.message);
        },
      );
    expect(await refused(new Uint8Array([1, 2, 3]))).toContain('the archive does not read');
    const body = await JSZip.loadAsync(good);
    body.remove('word/document.xml');
    expect(await refused(await body.generateAsync({ type: 'uint8array' }))).toContain(
      'word/document.xml is missing',
    );
    expect(await refused(await replacePart(good, 'word/styles.xml', '<a>\u000c</a>'))).toContain(
      'word/styles.xml is not valid XML',
    );
    expect(await refused(await replacePart(good, 'word/document.xml', '<other/>'))).toContain(
      'is not a document part',
    );
    expect(await refused(await replacePart(good, 'word/styles.xml', '<a>\u000c</a>'))).toContain(
      'The file was not saved or sent.',
    );
  });

  test('parts limits the check to the changed parts, so a foreign part never blocks an edit', async () => {
    const good = await createWordPackage('Report', [{ op: 'insert_paragraph', text: 'Body' }]);
    const foreign = await replacePart(good, 'customXml/odd.xml', '<a>\u000c</a>');
    await verifyOfficePackage(foreign, 'docx', { parts: ['word/document.xml'] });
    await expect(verifyOfficePackage(foreign, 'docx')).rejects.toThrow('customXml/odd.xml');
    // An edit of a file that holds a foreign part still works.
    const edited = await editWordPackage(foreign, [{ op: 'insert_paragraph', text: 'More' }]);
    expect((await readWordPackage(edited)).paragraphs.at(-1)?.text).toBe('More');
  });
});

describe('real files with control characters', () => {
  test('each Word edit that carries text makes a file that parses', async () => {
    const bytes = await createWordPackage(`Report${'\u000c'}`, [
      { op: 'insert_paragraph', text: CONTROL, heading: 1 },
      { op: 'insert_table', rows: [[CONTROL, 'B']] },
      { op: 'set_header_footer', area: 'header', text: CONTROL },
      { op: 'set_header_footer', area: 'footer', text: CONTROL },
      { op: 'add_comment', paragraph: 1, text: CONTROL, author: `Mara${'\u0001'}` },
      { op: 'replace_text', paragraph: 1, find: 'Friday', replacement: `Monday${'\u000c'}` },
    ]);
    await expectEveryPartParses(bytes);
    const read = await readWordPackage(bytes);
    expect(read.paragraphs[1].text).toBe('Pay by Monday');
    expect(JSON.stringify(read)).not.toContain('\u000c');
  });

  test('fill_blank with a control character parses and shows the clean value', async () => {
    const { bytes } = await renderTemplate('letter', {
      from: { name: 'Mara Ellison' },
      to: { name: 'Harbor Design' },
      subject: 'Note',
      body: ['Thanks.'],
    });
    const filled = await editWordPackage(bytes, [{ op: 'fill_blank', blank: 'Date', value: CONTROL }]);
    await expectEveryPartParses(filled);
    const blank = (await readWordPackage(filled)).blanks.find((entry) => entry.name === 'Date');
    expect(blank).toMatchObject({ value: CLEAN, filled: true });
  });

  test('a template with control characters in its data and title parses', async () => {
    const { bytes } = await renderTemplate(
      'invoice',
      {
        from: { name: CONTROL },
        billTo: { name: 'Harbor Design', lines: [CONTROL] },
        items: [{ title: CONTROL, summary: CONTROL, hours: 2, rate: 90 }],
        notes: CONTROL,
      },
      { title: `Invoice${'\u000c'}` },
    );
    await expectEveryPartParses(bytes);
  });

  test('each export kind sanitizes its text, then opens', async () => {
    const doc = await exportDocument(
      record('doc', {
        kind: 'doc',
        version: 1,
        blocks: [{ id: 'a', type: 'paragraph', text: CONTROL }],
      }),
    );
    await expectEveryPartParses(doc.bytes);
    expect(await (await JSZip.loadAsync(doc.bytes)).file('word/document.xml')!.async('string')).toContain(
      CLEAN,
    );
    const sheet = await exportDocument(
      record('sheet', {
        kind: 'sheet',
        version: 1,
        activeSheetId: 's',
        sheets: [
          {
            id: 's',
            name: `Sheet${'\u000c'}`,
            rowCount: 5,
            columnCount: 5,
            cells: { A1: { value: CONTROL } },
          },
        ],
      }),
    );
    await expectEveryPartParses(sheet.bytes);
    const deckModel = structuredClone(referenceDeck('editorial'));
    const text = deckModel.slides[0].elements.find((element) => element.type === 'text');
    if (text?.type === 'text') text.text = CONTROL;
    deckModel.slides[0].notes = CONTROL;
    const deck = await exportDocument(record('deck', deckModel));
    await expectEveryPartParses(deck.bytes);
    expect(
      await (await JSZip.loadAsync(deck.bytes)).file('ppt/slides/slide1.xml')!.async('string'),
    ).toContain(CLEAN);
  });
});

describe('document_create opens the file', () => {
  const saved = () =>
    mock(async (input: any) => ({
      documentId: 'made',
      title: input.title,
      kind: input.kind,
      currentRevision: 1,
    }));

  test('a document that does not build saves nothing and fails with the reason', async () => {
    const create = saved();
    __setDocumentToolDepsForTest({
      createDocument: create as any,
      recordOperation: (async () => 'operation') as any,
      exportDocument: async () => {
        throw new OfficeError('The server built a Word file that does not open (word/document.xml).');
      },
    });
    await expect(
      invokeTool(
        documentCreate,
        { kind: 'doc', title: 'Plan', blocks: [{ type: 'paragraph', text: 'Body' }] },
        toolContext(),
      ),
    ).rejects.toThrow('does not open');
    expect(create).not.toHaveBeenCalled();
  });

  test('a good document builds once and saves with a clean model', async () => {
    const create = saved();
    const built = mock(exportDocument);
    __setDocumentToolDepsForTest({
      createDocument: create as any,
      recordOperation: (async () => 'operation') as any,
      exportDocument: built,
    });
    const result: any = await invokeTool(
      documentCreate,
      { kind: 'doc', title: 'Plan', blocks: [{ type: 'paragraph', text: CONTROL }] },
      toolContext(),
    );
    expect(result.ok).toBe(true);
    expect(built).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('a saved deck whose PowerPoint file does not build says so in its notes', async () => {
    const create = saved();
    __setDocumentToolDepsForTest({
      createDocument: create as any,
      recordOperation: (async () => 'operation') as any,
      composeDocumentPresentation: (async () => ({
        title: 'Deck',
        summary: 'Reviewed.',
        model: referenceDeck('editorial'),
      })) as any,
      exportDocument: async () => {
        throw new Error('Asset fetch failed (404).');
      },
    });
    const result: any = await invokeTool(
      documentCreate,
      {
        kind: 'deck',
        title: 'Deck',
        presentation: {
          title: 'Deck',
          summary: 'A deck.',
          palette: 'ink',
          slides: [{ layout: 'cover', title: 'One', kicker: '', body: '', items: [], notes: '' }],
        },
      },
      toolContext(),
    );
    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.notes.join(' ')).toContain('The deck is saved, but its PowerPoint file did not build.');
    expect(result.notes.join(' ')).toContain('Asset fetch failed');
  });
});

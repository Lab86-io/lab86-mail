import { afterEach, expect, test } from 'bun:test';
import { __setGoogleDocumentDepsForTest, updateGoogleNativeFile } from '../lib/documents/google';
import { googleFileEditability } from '../lib/documents/google-fidelity';
import { __setGoogleImportDepsForTest, importGoogleNativeFile } from '../lib/documents/google-import';
import {
  googleLinkedFileSyncLimitation,
  LINKED_GOOGLE_FILE_SYNC_LIMITATION,
} from '../lib/documents/google-write-policy';
import { createDefaultDocumentModel } from '../lib/documents/model';

const paragraph = {
  startIndex: 1,
  endIndex: 8,
  paragraph: { elements: [{ textRun: { content: 'Source\n' } }] },
};
const plain = { revisionId: 'revision', body: { content: [paragraph] } };
afterEach(() => {
  __setGoogleDocumentDepsForTest();
  __setGoogleImportDepsForTest();
});

test('plain document round-trips preserve blank paragraphs without appending new ones', async () => {
  const access = (async () => ({ connection: { provider: 'google_drive' }, accessToken: 'fixture' })) as any;
  let batch: any;
  const source = {
    ...plain,
    body: {
      content: [
        paragraph,
        { startIndex: 8, endIndex: 9, paragraph: { elements: [{ textRun: { content: '\n' } }] } },
      ],
    },
  };
  const provider = (async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      batch = JSON.parse(String(init.body));
      return Response.json({});
    }
    return Response.json(
      String(url).includes('docs.googleapis.com') ? source : { name: 'Memo', version: '9' },
    );
  }) as any;
  __setGoogleImportDepsForTest({ getCloudFileAccess: access, fetch: provider });
  __setGoogleDocumentDepsForTest({ getCloudFileAccess: access, fetch: provider });
  const imported = await importGoogleNativeFile({
    userId: 'owner',
    connectionId: 'drive',
    fileId: 'doc',
    mimeType: 'application/vnd.google-apps.document',
  });
  expect(imported.model.kind).toBe('doc');
  if (imported.model.kind !== 'doc') throw new Error('Expected document');
  expect(imported.model.blocks.map((block) => block.text)).toEqual(['Source', '']);
  await updateGoogleNativeFile({
    userId: 'owner',
    connectionId: 'drive',
    fileId: 'doc',
    kind: 'doc',
    title: 'Memo',
    model: imported.model,
    expectedProviderVersion: '9',
  });
  expect(batch.requests.find((request: any) => request.insertText).insertText.text).toBe('Source\n');
  expect(
    batch.requests
      .filter((request: any) => request.updateParagraphStyle)
      .map((request: any) => request.updateParagraphStyle.paragraphStyle.namedStyleType),
  ).toEqual(['NORMAL_TEXT', 'NORMAL_TEXT']);
  expect(batch.writeControl.requiredRevisionId).toBe('revision');
});
test('only losslessly supported document content can be edited in place', () => {
  expect(googleFileEditability('doc', plain).editable).toBe(true);
  for (const source of [
    { ...plain, body: { content: [paragraph, { table: {} }] } },
    { ...plain, body: { content: [{ ...paragraph, paragraph: { ...paragraph.paragraph, bullet: {} } }] } },
    {
      ...plain,
      body: {
        content: [{ paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: 'image' } }] } }],
      },
    },
    {
      ...plain,
      body: {
        content: [
          { paragraph: { elements: [{ textRun: { content: 'Styled', textStyle: { bold: true } } }] } },
        ],
      },
    },
    { ...plain, tabs: [{}, {}] },
    { ...plain, suggestedDocumentStyleChanges: {} },
    { ...plain, body: { content: [paragraph, { sectionBreak: {}, endIndex: 9 }] } },
    {},
  ])
    expect(googleFileEditability('doc', source).editable).toBe(false);
  expect(googleFileEditability('sheet', {}).editable).toBe(false);
  expect(googleFileEditability('deck', {}).editable).toBe(false);
});
test('unsafe documents and missing version metadata cause zero provider mutations', async () => {
  for (const [source, version] of [
    [{ ...plain, body: { content: [paragraph, { table: {} }] } }, '9'],
    [{ ...plain, revisionId: undefined }, '9'],
    [plain, undefined],
  ] as const) {
    const writes: string[] = [];
    __setGoogleDocumentDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: { provider: 'google_drive' },
        accessToken: 'fixture',
      })) as any,
      fetch: (async (url: unknown, init?: RequestInit) => {
        if (init?.method && init.method !== 'GET') writes.push(String(url));
        return Response.json(String(url).includes('docs.googleapis.com') ? source : { version });
      }) as any,
    });
    await expect(
      updateGoogleNativeFile({
        userId: 'owner',
        connectionId: 'drive',
        fileId: 'doc',
        kind: 'doc',
        title: 'Edit',
        model: createDefaultDocumentModel('doc'),
        expectedProviderVersion: '9',
      }),
    ).rejects.toThrow();
    expect(writes).toEqual([]);
  }
});

// DOC-1: the document the writer produces must read back as editable, with
// the same block types. This is the shape Docs returns after a save with a
// list, a numbered list, a quote, and a heading.
const quoteColor = { color: { rgbColor: { red: 0x52 / 255, green: 0x60 / 255, blue: 0x6d / 255 } } };
const written = {
  revisionId: 'revision-2',
  lists: {
    'kix.bullets': { listProperties: { nestingLevels: [{ glyphSymbol: '●', indentStart: {} }] } },
    'kix.numbers': { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL', glyphFormat: '%0.' }] } },
  },
  body: {
    content: [
      { sectionBreak: {}, endIndex: 1 },
      {
        paragraph: {
          elements: [{ startIndex: 1, endIndex: 7, textRun: { content: 'Title\n', textStyle: {} } }],
          paragraphStyle: { namedStyleType: 'HEADING_1', direction: 'LEFT_TO_RIGHT' },
        },
      },
      {
        paragraph: {
          elements: [{ textRun: { content: 'Milk\n', textStyle: {} } }],
          paragraphStyle: {
            namedStyleType: 'NORMAL_TEXT',
            direction: 'LEFT_TO_RIGHT',
            indentFirstLine: { magnitude: 18, unit: 'PT' },
            indentStart: { magnitude: 36, unit: 'PT' },
          },
          bullet: { listId: 'kix.bullets', textStyle: { underline: false } },
        },
      },
      {
        paragraph: {
          elements: [{ textRun: { content: 'Step one\n' } }],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT', indentStart: { magnitude: 36, unit: 'PT' } },
          bullet: { listId: 'kix.numbers' },
        },
      },
      {
        paragraph: {
          elements: [
            { textRun: { content: 'Said well', textStyle: { italic: true, foregroundColor: quoteColor } } },
            { textRun: { content: '\n', textStyle: {} } },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT', indentStart: { magnitude: 24, unit: 'PT' } },
        },
      },
    ],
  },
};

test('a document the writer saved stays editable and keeps its block types (DOC-1)', async () => {
  expect(googleFileEditability('doc', written)).toEqual({ editable: true });
  const access = (async () => ({ connection: { provider: 'google_drive' }, accessToken: 'fixture' })) as any;
  __setGoogleImportDepsForTest({
    getCloudFileAccess: access,
    fetch: (async (url: unknown) =>
      Response.json(
        String(url).includes('docs.googleapis.com') ? written : { name: 'Memo', version: '3' },
      )) as any,
  });
  const imported = await importGoogleNativeFile({
    userId: 'owner',
    connectionId: 'drive',
    fileId: 'doc',
    mimeType: 'application/vnd.google-apps.document',
  });
  if (imported.model.kind !== 'doc') throw new Error('Expected document');
  expect(imported.model.blocks.map((block) => [block.type, block.text])).toEqual([
    ['heading', 'Title'],
    ['bullet', 'Milk'],
    ['numbered', 'Step one'],
    ['quote', 'Said well'],
  ]);
});

test('lists and quotes outside the writer subset stay preview only', () => {
  const withParagraph = (paragraph: any) => ({ ...written, body: { content: [{ paragraph }] } });
  const nested = withParagraph({
    elements: [{ textRun: { content: 'Deep\n' } }],
    bullet: { listId: 'kix.bullets', nestingLevel: 1 },
  });
  const unknownList = withParagraph({
    elements: [{ textRun: { content: 'x\n' } }],
    bullet: { listId: 'missing' },
  });
  const boldQuote = withParagraph({
    elements: [
      { textRun: { content: 'Loud', textStyle: { bold: true, italic: true, foregroundColor: quoteColor } } },
    ],
    paragraphStyle: { indentStart: { magnitude: 24, unit: 'PT' } },
  });
  const otherIndent = withParagraph({
    elements: [{ textRun: { content: 'x', textStyle: { italic: true, foregroundColor: quoteColor } } }],
    paragraphStyle: { indentStart: { magnitude: 48, unit: 'PT' } },
  });
  const plainIndent = withParagraph({
    elements: [{ textRun: { content: 'x\n' } }],
    paragraphStyle: { indentStart: { magnitude: 24, unit: 'PT' } },
  });
  const hanging = withParagraph({
    elements: [{ textRun: { content: 'x\n' } }],
    paragraphStyle: { indentFirstLine: { magnitude: 24, unit: 'PT' } },
  });
  for (const source of [nested, unknownList, boldQuote, otherIndent, plainIndent, hanging])
    expect(googleFileEditability('doc', source).editable).toBe(false);
});

test('a linked spreadsheet or deck never offers Sync Google (DOC-3)', () => {
  expect(googleLinkedFileSyncLimitation('deck', { fileId: 'g1' })).toBe(LINKED_GOOGLE_FILE_SYNC_LIMITATION);
  expect(googleLinkedFileSyncLimitation('sheet', { fileId: 'g1' })).toBe(LINKED_GOOGLE_FILE_SYNC_LIMITATION);
  expect(googleLinkedFileSyncLimitation('doc', { fileId: 'g1' })).toBeNull();
  expect(googleLinkedFileSyncLimitation('deck', undefined)).toBeNull();
});

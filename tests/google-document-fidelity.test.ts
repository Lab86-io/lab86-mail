import { afterEach, expect, test } from 'bun:test';
import { __setGoogleDocumentDepsForTest, updateGoogleNativeFile } from '../lib/documents/google';
import { googleFileEditability } from '../lib/documents/google-fidelity';
import { __setGoogleImportDepsForTest, importGoogleNativeFile } from '../lib/documents/google-import';
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

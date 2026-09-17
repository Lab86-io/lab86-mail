import { afterEach, describe, expect, test } from 'bun:test';
import { DECK_THEMES } from '../lib/documents/deck-fixtures';
import {
  __setGoogleDocumentDepsForTest,
  GoogleDocumentConflictError,
  publishDocumentToGoogle,
  updateGoogleNativeFile,
} from '../lib/documents/google';
import type { AlbatrossDocumentModel, AlbatrossDocumentRecord, DeckModelV2 } from '../lib/documents/model';

afterEach(() => __setGoogleDocumentDepsForTest());

const connection = { connectionId: 'google-1', provider: 'google_drive', status: 'connected', scopes: [] };
const access = { connection, accessToken: 'access-token' };

/** A plain, losslessly editable Docs body, as the fidelity gate accepts it. */
const editableDoc = {
  revisionId: 'rev-1',
  body: {
    content: [
      { startIndex: 1, endIndex: 8, paragraph: { elements: [{ textRun: { content: 'Source\n' } }] } },
    ],
  },
};

type Captured = { url: string; init?: RequestInit };

function installPublisher(options: { docs?: unknown; version?: string } = {}) {
  const requests: Captured[] = [];
  const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
    const endpoint = String(url);
    requests.push({ url: endpoint, init });
    if (init?.method === 'POST') {
      if (endpoint === 'https://slides.googleapis.com/v1/presentations')
        return Response.json({ presentationId: 'created-deck' });
      if (endpoint === 'https://docs.googleapis.com/v1/documents')
        return Response.json({ documentId: 'created-doc' });
      if (endpoint === 'https://sheets.googleapis.com/v4/spreadsheets')
        return Response.json({ spreadsheetId: 'created-sheet' });
      return Response.json({});
    }
    if (endpoint.includes('slides.googleapis.com'))
      return Response.json({ slides: [{ objectId: 'old-slide' }] });
    if (endpoint.includes('sheets.googleapis.com'))
      return Response.json({ sheets: [{ properties: { sheetId: 0 } }, { properties: { sheetId: 9 } }] });
    if (endpoint.includes('docs.googleapis.com')) return Response.json(options.docs ?? editableDoc);
    return Response.json({ webViewLink: 'https://drive.google.com/open', version: options.version ?? '9' });
  };
  __setGoogleDocumentDepsForTest({
    getCloudFileAccess: (async () => access) as any,
    listCloudFileConnections: (async () => [connection]) as any,
    linkGoogleDocument: (async () => ({ ok: true })) as any,
    fetch: fetchMock as any,
  });
  return requests;
}

function batchBody(requests: Captured[], fragment: string) {
  const hit = requests.find((request) => request.url.includes(fragment) && request.init?.method === 'POST');
  if (!hit) throw new Error(`No POST to ${fragment}`);
  return JSON.parse(String(hit.init?.body)) as { requests: Record<string, any>[] };
}

function record(model: AlbatrossDocumentModel, extra: Partial<AlbatrossDocumentRecord> = {}) {
  return {
    documentId: 'document',
    kind: model.kind,
    title: 'Publish',
    model,
    currentRevision: 3,
    sourceRefs: [],
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  } as AlbatrossDocumentRecord;
}

describe('version 2 deck to Google Slides requests', () => {
  test('each element kind maps to its native request or a text box with its data', async () => {
    const model: DeckModelV2 = {
      kind: 'deck',
      version: 2,
      activeSlideId: 'one',
      theme: DECK_THEMES.editorial,
      slides: [
        {
          id: 'one',
          title: 'Mapping',
          elements: [
            {
              id: 'centered',
              type: 'text',
              role: 'title',
              text: 'Centered',
              align: 'center',
              italic: true,
              color: '#123456',
              x: 5,
              y: 5,
              width: 90,
              height: 10,
            },
            {
              id: 'right',
              type: 'text',
              text: 'Right',
              align: 'right',
              fontSize: 14,
              fontWeight: 700,
              x: 5,
              y: 16,
              width: 90,
              height: 6,
            },
            {
              id: 'left',
              type: 'text',
              role: 'number',
              text: '7',
              align: 'left',
              x: 5,
              y: 23,
              width: 20,
              height: 12,
            },
            { id: 'blank', type: 'text', text: '', align: 'center', x: 30, y: 23, width: 20, height: 12 },
            { id: 'rect', type: 'shape', x: 5, y: 40, width: 20, height: 10 },
            {
              id: 'round',
              type: 'shape',
              shape: 'roundRect',
              stroke: { color: '#AE4B2B', width: 2 },
              x: 30,
              y: 40,
              width: 20,
              height: 10,
            },
            {
              id: 'ellipse',
              type: 'shape',
              shape: 'ellipse',
              stroke: { color: '#1E2A38', width: 1 },
              x: 55,
              y: 40,
              width: 10,
              height: 10,
            },
            {
              id: 'flipped',
              type: 'line',
              flip: true,
              stroke: { color: '#1E2A38', width: 1.5 },
              x: 10,
              y: 50,
              width: 80,
              height: 10,
            },
            {
              id: 'plain',
              type: 'line',
              stroke: { color: '#5E5A51', width: 1 },
              x: 10,
              y: 62,
              width: 80,
              height: 0,
            },
            {
              id: 'remote',
              type: 'image',
              assetId: 'remote-asset',
              src: 'https://cdn.example.test/photo.png',
              alt: 'Remote',
              x: 5,
              y: 65,
              width: 20,
              height: 20,
            },
            {
              id: 'local',
              type: 'image',
              assetId: 'local-asset',
              src: '/art/fallback-1.jpg',
              alt: 'Hills',
              x: 30,
              y: 65,
              width: 20,
              height: 20,
            },
            {
              id: 'unnamed',
              type: 'image',
              assetId: 'asset-42',
              alt: '',
              x: 55,
              y: 65,
              width: 20,
              height: 20,
            },
            {
              id: 'chart',
              type: 'chart',
              chart: 'bar',
              categories: ['Q1', 'Q2'],
              series: [
                { name: 'Spend', values: [1, 2] },
                { name: 'Plan', values: [3] },
              ],
              unit: 'k',
              x: 5,
              y: 88,
              width: 90,
              height: 10,
            },
          ],
        },
      ],
    };
    const requests = installPublisher();
    const published = await publishDocumentToGoogle({ userId: 'user-1', document: record(model) });
    expect(published.fileId).toBe('created-deck');
    const { requests: batch } = batchBody(requests, 'presentations/created-deck:batchUpdate');
    expect(batch[0]).toEqual({ deleteObject: { objectId: 'old-slide' } });
    expect(batch[1].createSlide).toMatchObject({ objectId: 'one_0' });

    const byId = (id: string) => batch.filter((request) => Object.values(request)[0]?.objectId === id);
    const centered = byId('centered_0');
    expect(centered.map((request) => Object.keys(request)[0])).toEqual([
      'createShape',
      'insertText',
      'updateTextStyle',
      'updateParagraphStyle',
    ]);
    expect(centered[2].updateTextStyle.style).toMatchObject({
      fontSize: { magnitude: 28, unit: 'PT' },
      bold: true,
      italic: true,
      foregroundColor: {
        opaqueColor: { rgbColor: { red: 0x12 / 255, green: 0x34 / 255, blue: 0x56 / 255 } },
      },
    });
    expect(centered[3].updateParagraphStyle.style.alignment).toBe('CENTER');
    const right = byId('right_1');
    expect(right[2].updateTextStyle.style).toMatchObject({
      fontSize: { magnitude: 14 },
      bold: true,
      italic: false,
    });
    expect(right[3].updateParagraphStyle.style.alignment).toBe('END');
    const left = byId('left_2');
    expect(left[2].updateTextStyle.style).toMatchObject({ fontSize: { magnitude: 64 }, bold: true });
    expect(left[3].updateParagraphStyle.style.alignment).toBe('START');
    // Empty text creates the box only; no text, style or alignment requests follow.
    expect(byId('blank_3').map((request) => Object.keys(request)[0])).toEqual(['createShape']);

    const rect = byId('rect_4');
    expect(rect[0].createShape.shapeType).toBe('RECTANGLE');
    expect(rect[1].updateShapeProperties.shapeProperties.outline).toEqual({ propertyState: 'NOT_RENDERED' });
    expect(
      rect[1].updateShapeProperties.shapeProperties.shapeBackgroundFill.solidFill.color.rgbColor,
    ).toEqual({
      red: 0xe7 / 255,
      green: 0xe1 / 255,
      blue: 0xd3 / 255,
    });
    const round = byId('round_5');
    expect(round[0].createShape.shapeType).toBe('ROUND_RECTANGLE');
    expect(round[1].updateShapeProperties.shapeProperties.outline).toMatchObject({
      weight: { magnitude: 2, unit: 'PT' },
      outlineFill: { solidFill: { color: { rgbColor: { red: 0xae / 255 } } } },
    });
    expect(byId('ellipse_6')[0].createShape.shapeType).toBe('ELLIPSE');

    const flipped = byId('flipped_7');
    expect(flipped[0].createLine.lineCategory).toBe('STRAIGHT');
    expect(flipped[0].createLine.elementProperties.transform).toMatchObject({
      scaleX: 1,
      scaleY: -1,
      translateX: 72,
      translateY: 243,
    });
    expect(flipped[1].updateLineProperties.lineProperties.weight).toEqual({ magnitude: 1.5, unit: 'PT' });
    const plain = byId('plain_8');
    expect(plain[0].createLine.elementProperties.transform).toMatchObject({ scaleY: 1, translateY: 251.1 });
    expect(plain[0].createLine.elementProperties.size.height).toEqual({ magnitude: 1, unit: 'PT' });

    expect(byId('remote_9')).toEqual([
      {
        createImage: {
          objectId: 'remote_9',
          url: 'https://cdn.example.test/photo.png',
          elementProperties: expect.objectContaining({ pageObjectId: 'one_0' }),
        },
      },
    ]);
    const local = byId('local_10');
    expect(local[0].createShape.shapeType).toBe('TEXT_BOX');
    expect(local[1].insertText.text).toBe('[Image: Hills]');
    expect(local[2].updateTextStyle.style).toMatchObject({
      fontSize: { magnitude: 12 },
      bold: false,
      italic: false,
    });
    expect(byId('unnamed_11')[1].insertText.text).toBe('[Image: asset-42]');

    const chart = byId('chart_12');
    expect(chart[0].createShape.shapeType).toBe('TEXT_BOX');
    expect(chart[1].insertText.text).toBe('Spend: Q1 1k, Q2 2k\nPlan: Q1 3k, Q2 k');
  });
});

describe('Google request failures', () => {
  function failWith(response: () => Promise<Response>) {
    __setGoogleDocumentDepsForTest({
      getCloudFileAccess: (async () => access) as any,
      listCloudFileConnections: (async () => [connection]) as any,
      linkGoogleDocument: (async () => ({ ok: true })) as any,
      fetch: (async () => response()) as any,
    });
  }
  const deck = () =>
    record({
      kind: 'deck',
      version: 2,
      activeSlideId: 'one',
      theme: DECK_THEMES.signal,
      slides: [{ id: 'one', title: 'Only', elements: [] }],
    });

  test('a timed out request reports the timeout', async () => {
    failWith(async () => {
      throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
    });
    await expect(publishDocumentToGoogle({ userId: 'user-1', document: deck() })).rejects.toThrow(
      'Google request timed out. Try again.',
    );
  });

  test('other transport errors pass through unchanged', async () => {
    failWith(async () => {
      throw new Error('socket closed');
    });
    await expect(publishDocumentToGoogle({ userId: 'user-1', document: deck() })).rejects.toThrow(
      'socket closed',
    );
  });

  test('a provider error carries its detail when Google supplies one', async () => {
    failWith(async () => Response.json({ error: { message: 'Quota exceeded' } }, { status: 500 }));
    await expect(publishDocumentToGoogle({ userId: 'user-1', document: deck() })).rejects.toThrow(
      'Google could not update this file: Quota exceeded',
    );
    failWith(async () => new Response('not json', { status: 500 }));
    await expect(publishDocumentToGoogle({ userId: 'user-1', document: deck() })).rejects.toThrow(
      'Google could not update this file.',
    );
    failWith(async () => Response.json({}, { status: 403 }));
    await expect(publishDocumentToGoogle({ userId: 'user-1', document: deck() })).rejects.toThrow(
      'Google write access is missing or expired',
    );
  });
});

describe('Google Docs sync branches', () => {
  const doc = () =>
    record({
      kind: 'doc',
      version: 1,
      blocks: [
        { id: 'h3', type: 'heading', level: 3, text: 'Third level' },
        { id: 'p', type: 'paragraph', text: 'Body' },
        { id: 'b', type: 'bullet', text: 'Point' },
        { id: 'n', type: 'numbered', text: 'Step' },
        { id: 'q', type: 'quote', text: 'Said' },
      ],
    });

  test('a new document with an empty provider body writes every block style without a delete', async () => {
    const requests = installPublisher({ docs: {} });
    const published = await publishDocumentToGoogle({ userId: 'user-1', document: doc() });
    expect(published.fileId).toBe('created-doc');
    const body = batchBody(requests, 'documents/created-doc:batchUpdate') as Record<string, any>;
    expect(body.requests.some((request: any) => request.deleteContentRange)).toBe(false);
    expect(body.writeControl).toBeUndefined();
    const paragraphStyles = body.requests
      .filter((request: any) => request.updateParagraphStyle)
      .map((request: any) => request.updateParagraphStyle.paragraphStyle);
    expect(paragraphStyles.map((style: any) => style.namedStyleType).filter(Boolean)).toEqual([
      'HEADING_3',
      'NORMAL_TEXT',
      'NORMAL_TEXT',
      'NORMAL_TEXT',
      'NORMAL_TEXT',
    ]);
    expect(paragraphStyles.at(-1)).toEqual({ indentStart: { magnitude: 24, unit: 'PT' } });
    expect(
      body.requests
        .filter((request: any) => request.createParagraphBullets)
        .map((request: any) => request.createParagraphBullets.bulletPreset),
    ).toEqual(['BULLET_DISC_CIRCLE_SQUARE', 'NUMBERED_DECIMAL_NESTED']);
    expect(
      body.requests.find((request: any) => request.updateTextStyle).updateTextStyle.textStyle.italic,
    ).toBe(true);
  });

  test('an existing document republishes in place when the Google version still matches', async () => {
    const requests = installPublisher();
    const existing = doc();
    existing.google = {
      connectionId: 'google-1',
      fileId: 'existing-doc',
      mimeType: 'application/vnd.google-apps.document',
      webUrl: 'https://docs.google.com/document/d/existing-doc/edit',
      providerVersion: '9',
      syncedRevision: 2,
    } as any;
    const published = await publishDocumentToGoogle({ userId: 'user-1', document: existing });
    expect(published.fileId).toBe('existing-doc');
    expect(published.webUrl).toBe('https://drive.google.com/open');
    expect(requests.some((request) => request.url === 'https://docs.googleapis.com/v1/documents')).toBe(
      false,
    );
    const body = batchBody(requests, 'documents/existing-doc:batchUpdate') as Record<string, any>;
    expect(body.writeControl).toEqual({ requiredRevisionId: 'rev-1' });
  });

  test('a changed Google version or a missing connection stops a republish', async () => {
    installPublisher({ version: '10' });
    const stale = doc();
    stale.google = {
      connectionId: 'google-1',
      fileId: 'existing-doc',
      mimeType: 'application/vnd.google-apps.document',
      providerVersion: '9',
      syncedRevision: 2,
    } as any;
    await expect(publishDocumentToGoogle({ userId: 'user-1', document: stale })).rejects.toBeInstanceOf(
      GoogleDocumentConflictError,
    );
    __setGoogleDocumentDepsForTest({ listCloudFileConnections: (async () => []) as any });
    await expect(publishDocumentToGoogle({ userId: 'user-1', document: doc() })).rejects.toThrow(
      'Connect Google Drive before publishing this file.',
    );
    installPublisher();
    __setGoogleDocumentDepsForTest({
      listCloudFileConnections: (async () => [connection]) as any,
      getCloudFileAccess: (async () => null) as any,
    });
    await expect(publishDocumentToGoogle({ userId: 'user-1', document: doc() })).rejects.toThrow(
      'The selected Google Drive connection was not found.',
    );
  });

  test('a spreadsheet publish replaces extra tabs, clears values and writes each grid', async () => {
    const requests = installPublisher();
    const published = await publishDocumentToGoogle({
      userId: 'user-1',
      document: record({
        kind: 'sheet',
        version: 1,
        activeSheetId: 'one',
        sheets: [
          {
            id: 'one',
            name: "Q1 'Budget'",
            rowCount: 4,
            columnCount: 3,
            cells: {
              A1: { value: 'Total' },
              B2: { formula: '=A1' },
              C1: { value: 5 },
              Z9: { value: 'outside' },
              bad: { value: 'skipped' },
            },
          },
          { id: 'two', name: 'Notes', rowCount: 2, columnCount: 2, cells: {} },
        ],
      }),
    });
    expect(published.fileId).toBe('created-sheet');
    const structure = batchBody(requests, 'spreadsheets/created-sheet:batchUpdate');
    expect(structure.requests).toEqual([
      { deleteSheet: { sheetId: 9 } },
      { updateSheetProperties: { properties: { sheetId: 0, title: "Q1 'Budget'" }, fields: 'title' } },
      { addSheet: { properties: { title: 'Notes' } } },
    ]);
    const clear = batchBody(requests, 'values:batchClear') as Record<string, any>;
    expect(clear.ranges).toEqual(["'Q1 ''Budget'''", "'Notes'"]);
    const values = batchBody(requests, 'values:batchUpdate') as Record<string, any>;
    expect(values.data).toEqual([
      {
        range: "'Q1 ''Budget'''!A1:C2",
        majorDimension: 'ROWS',
        values: [
          ['Total', '', 5],
          ['', '=A1', ''],
        ],
      },
      { range: "'Notes'!A1:A1", majorDimension: 'ROWS', values: [['']] },
    ]);
  });

  test('an in-place update syncs the body, renames the file and returns the new version', async () => {
    const requests = installPublisher();
    const updated = await updateGoogleNativeFile({
      userId: 'user-1',
      connectionId: 'google-1',
      fileId: 'existing-doc',
      kind: 'doc',
      title: '  Memo  ',
      model: doc().model,
      expectedProviderVersion: '9',
    });
    expect(updated).toMatchObject({
      title: 'Memo',
      webUrl: 'https://drive.google.com/open',
      providerVersion: '9',
    });
    const rename = requests.find((request) => request.init?.method === 'PATCH');
    expect(rename?.url).toContain('drive/v3/files/existing-doc');
    expect(JSON.parse(String(rename?.init?.body))).toEqual({ name: 'Memo' });
    expect(requests.some((request) => request.url.includes('documents/existing-doc:batchUpdate'))).toBe(true);
  });

  test('an update without a Google Drive connection is refused', async () => {
    __setGoogleDocumentDepsForTest({ getCloudFileAccess: (async () => null) as any });
    await expect(
      updateGoogleNativeFile({
        userId: 'user-1',
        connectionId: 'missing',
        fileId: 'doc',
        kind: 'doc',
        title: 'Edit',
        model: doc().model,
        expectedProviderVersion: '9',
      }),
    ).rejects.toThrow('The selected Google Drive connection was not found.');
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
  chatFileType,
  chatUploadId,
  isChatAttachmentUrl,
  MAX_CHAT_BYTES,
  validateChatFiles,
} from '../lib/ai/chat-attachments';
import { __setChatUploadDepsForTest, hydrateChatAttachments } from '../lib/ai/chat-upload-content';
import { __setObjectGenerationDepsForTest, generateObjectForCurrentUser } from '../lib/ai/gateway';
import { exportDocument } from '../lib/documents/export';
import {
  __setGoogleWorkingCopyDepsForTest,
  downloadGoogleWorkingCopy,
  saveGoogleWorkingCopy,
} from '../lib/documents/google-working-copy';
import { createDefaultDocumentModel, deckModelSchema } from '../lib/documents/model';
import { officeConfiguration } from '../lib/documents/office-security';
import {
  composePresentation,
  presentationBriefSchema,
  requestedPresentationSlideCount,
} from '../lib/documents/presentation-design';

afterEach(() => {
  __setChatUploadDepsForTest();
  __setGoogleWorkingCopyDepsForTest();
  __setObjectGenerationDepsForTest();
});
async function officeBytes(kind: 'doc' | 'sheet' | 'deck') {
  return new Uint8Array(
    (
      await exportDocument({
        documentId: 'test',
        title: 'Test',
        kind,
        model: createDefaultDocumentModel(kind),
        currentRevision: 1,
        sourceRefs: [],
        createdAt: 1,
        updatedAt: 1,
      })
    ).bytes,
  );
}

describe('dogfood regressions', () => {
  test('legacy inline text still works, and arbitrary remote file URLs never get fetched', async () => {
    __setChatUploadDepsForTest({
      fetch: async () => {
        throw new Error('must not fetch');
      },
    });
    const message = (url: string) =>
      [
        {
          id: 'legacy',
          role: 'user',
          parts: [{ type: 'file', filename: 'notes.txt', mediaType: 'text/plain', url }],
        },
      ] as any;
    const output = await hydrateChatAttachments(
      'owner',
      message('data:text/plain;base64,' + Buffer.from('Saved notes').toString('base64')),
    );
    expect((output[0].parts[0] as any).text).toContain('Saved notes');
    await expect(hydrateChatAttachments('owner', message('http://127.0.0.1/private'))).rejects.toThrow(
      'Reattach',
    );
  });

  test('explicit six-slide recap counts cannot become a one-slide placeholder', () => {
    expect(requestedPresentationSlideCount('Fill in a 6-slide recap')).toBe(6);
    expect(requestedPresentationSlideCount('Make six slides')).toBe(6);
    expect(requestedPresentationSlideCount('Make a presentation')).toBeUndefined();
  });

  test.each([
    'openai',
    'openrouter',
  ])('structured generation allows mandatory reasoning on %s', async (provider) => {
    let request: any;
    __setObjectGenerationDepsForTest({
      resolveAiRuntime: async () =>
        ({ userId: 'u', source: 'lab86', provider, modelName: 'gpt-5-nano', model: 'test' }) as any,
      generateObject: (async (input: any) => {
        request = input;
        return { object: {} };
      }) as any,
      recordUsage: async () => {},
    });
    await generateObjectForCurrentUser({
      speed: 'primary',
      feature: 'document_generation',
      schema: {},
      prompt: 'test',
    });
    expect(request.providerOptions.openai).toEqual({ strictJsonSchema: true });
  });
  test('six slides export with distinct art direction and editable content', async () => {
    const brief = presentationBriefSchema.parse({
      title: 'A day of shipping',
      summary: 'Verified recap',
      palette: 'ink',
      slides: ['cover', 'metrics', 'columns', 'timeline', 'statement', 'columns'].map((layout, index) => ({
        layout,
        title: `Outcome ${index + 1}`,
        kicker: 'SEPTEMBER 10',
        body: 'A supported observation.',
        items: [{ label: '4 builds', detail: 'Verified build results' }],
        notes: 'Source date was checked.',
      })),
    });
    const model = deckModelSchema.parse(composePresentation(brief));
    expect(model.slides).toHaveLength(6);
    expect(new Set(model.slides.map((slide) => slide.background)).size).toBe(2);
    for (const slide of model.slides)
      for (const element of slide.elements) {
        expect(element.x + element.width).toBeLessThanOrEqual(100);
        expect(element.y + element.height).toBeLessThanOrEqual(100);
      }
    const bytes = await exportDocument({
      documentId: 'deck',
      title: brief.title,
      kind: 'deck',
      model,
      currentRevision: 1,
      sourceRefs: [],
      createdAt: 1,
      updatedAt: 1,
    });
    const zip = await JSZip.loadAsync(bytes.bytes);
    expect(Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(
      6,
    );
    expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toContain('Outcome 1');
  });
  test('attachment validation never silently drops files', () => {
    expect(chatFileType({ name: 'budget.xlsx', type: '' })).toContain('spreadsheetml');
    expect(validateChatFiles(Array.from({ length: 6 }, () => ({ name: 'a.txt', size: 1 })))).toContain(
      'at most 5',
    );
    expect(validateChatFiles([{ name: 'a.txt', size: MAX_CHAT_BYTES + 1 }])).toContain('25 MB');
    expect(validateChatFiles([{ name: 'a.exe', size: 1 }])).toContain('not supported');
    expect(chatUploadId('https://evil.test/api/agent/uploads/id')).toBeNull();
    expect(isChatAttachmentUrl('data:text/plain;base64,eA==')).toBe(true);
    expect(isChatAttachmentUrl('data:text/html;base64,eA==')).toBe(false);
    expect(isChatAttachmentUrl('javascript:alert(1)')).toBe(false);
  });
  test('file hydration reads the owning record, ignores spoofed metadata, and reuses storage once', async () => {
    const calls: any[] = [];
    __setChatUploadDepsForTest({
      convexQuery: (async (_ref, args) => {
        calls.push(args);
        return { url: 'https://storage.test/file', name: 'owned.txt', contentType: 'text/plain', size: 7 };
      }) as any,
      fetch: async () => new Response('evidence'),
    });
    const part = {
      type: 'file',
      url: '/api/agent/uploads/upload-1',
      filename: 'spoof.png',
      mediaType: 'image/png',
    };
    const output = await hydrateChatAttachments('owner', [
      { id: '1', role: 'user', parts: [part, part] },
    ] as any);
    expect(calls).toEqual([{ userId: 'owner', uploadId: 'upload-1' }]);
    expect((output[0].parts[0] as any).text).toContain('evidence');
    expect((output[0].parts[0] as any).text).toContain('owned.txt');
    expect(output[0].parts[0].type).toBe('text');
  });
  test('another user cannot hydrate a private upload', async () => {
    __setChatUploadDepsForTest({
      convexQuery: (async () => null) as any,
      fetch: async () => {
        throw new Error('must not fetch');
      },
    });
    await expect(
      hydrateChatAttachments('stranger', [
        { id: '1', role: 'user', parts: [{ type: 'file', url: '/api/agent/uploads/private' }] },
      ] as any),
    ).rejects.toThrow('no longer available');
  });
  test('xlsx context resolves shared strings and associates cells with values', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Budget');
    sheet.getCell('A1').value = 'Revenue';
    sheet.getCell('B1').value = 1234;
    sheet.getCell('C1').value = { formula: 'B1*2', result: 2468 };
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
    __setChatUploadDepsForTest({
      convexQuery: (async () => ({
        url: 'https://storage.test/file',
        name: 'budget.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: bytes.length,
      })) as any,
      fetch: async () => new Response(bytes),
    });
    const result = await hydrateChatAttachments('u', [
      { id: '1', role: 'user', parts: [{ type: 'file', url: '/api/agent/uploads/xlsx' }] },
    ] as any);
    const text = (result[0].parts[0] as any).text;
    expect(text).toContain('A1: Revenue');
    expect(text).toContain('B1: 1234');
    expect(text).toContain('B1*2');
  });
  test('Collabora is enabled without an ONLYOFFICE commercial flag', () => {
    expect(
      officeConfiguration({
        OFFICE_EDITOR_PROVIDER: 'collabora',
        OFFICE_EDITOR_ENABLED: 'true',
        OFFICE_JWT_SECRET: 'x'.repeat(32),
        OFFICE_DOCUMENT_SERVER_URL: 'https://documents.test',
        OFFICE_APP_ORIGIN: 'https://app.test',
      })?.provider,
    ).toBe('collabora');
  });
});

describe('Google working copy', () => {
  test('opening retries a conversion that changes version during export', async () => {
    const bytes = await officeBytes('doc');
    let reads = 0;
    let exports = 0;
    __setGoogleWorkingCopyDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: { provider: 'google_drive' },
        accessToken: 'test',
      })) as any,
      encryptSecret: (value) => value,
      fetch: async (url) => {
        if (String(url).includes('/export?')) {
          exports++;
          return new Response(bytes);
        }
        reads++;
        return Response.json({
          title: 'Document',
          mimeType: 'application/vnd.google-apps.document',
          etag: reads === 1 ? 'before-conversion' : 'stable',
          version: reads === 1 ? '1' : '2',
        });
      },
    });
    const copy = await downloadGoogleWorkingCopy({
      userId: 'owner',
      connectionId: 'connection',
      fileId: 'file',
    });
    expect(exports).toBe(2);
    expect(JSON.parse(copy.session).etag).toBe('stable');
  });

  test.each([
    'doc',
    'sheet',
    'deck',
  ] as const)('conditional %s replacement updates the same Google file', async (kind) => {
    const bytes = await officeBytes(kind);
    const native = { doc: 'document', sheet: 'spreadsheet', deck: 'presentation' }[kind];
    const calls: { url: string; init?: RequestInit }[] = [];
    __setGoogleWorkingCopyDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: { provider: 'google_drive' },
        accessToken: 'test-token',
      })) as any,
      encryptSecret: (s) => s,
      decryptSecret: (s) => s,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).includes('/export?')) return new Response(bytes);
        if (init?.method === 'PUT') return Response.json({ id: 'original', version: '2', etag: 'etag2' });
        return Response.json({
          id: 'original',
          title: 'Report',
          mimeType: `application/vnd.google-apps.${native}`,
          etag: 'etag1',
          version: '1',
          editable: true,
        });
      },
    });
    const copy = await downloadGoogleWorkingCopy({
      userId: 'owner',
      connectionId: 'connection',
      fileId: 'original',
    });
    const saved = await saveGoogleWorkingCopy({
      userId: 'owner',
      session: copy.session,
      bytes,
      extension: copy.extension,
    });
    const upload = calls.find((call) => call.init?.method === 'PUT')!;
    expect(upload.url).toContain('/files/original?uploadType=multipart&convert=true');
    expect(new Headers(upload.init!.headers).get('If-Match')).toBe('etag1');
    expect(JSON.parse(saved.session).etag).toBe('etag2');
    expect(saved.fileId).toBe('original');
    expect(Buffer.from(upload.init!.body as any).includes(Buffer.from(bytes))).toBe(true);
  });
  test('a changed original, expired or foreign session cannot be overwritten', async () => {
    const bytes = await officeBytes('doc');
    let writes = 0;
    __setGoogleWorkingCopyDepsForTest({
      decryptSecret: (s) => s,
      getCloudFileAccess: (async () => ({
        connection: { provider: 'google_drive' },
        accessToken: 'test',
      })) as any,
      fetch: async (_url, init) => {
        if (init?.method === 'PUT') writes++;
        return Response.json({ mimeType: 'application/vnd.google-apps.document', etag: 'new', version: '2' });
      },
    });
    const session = {
      userId: 'owner',
      connectionId: 'connection',
      fileId: 'file',
      mimeType: 'application/vnd.google-apps.document',
      etag: 'old',
      version: '1',
      expiresAt: Date.now() + 100000,
    };
    const save = (userId: string, value = session) =>
      saveGoogleWorkingCopy({ userId, session: JSON.stringify(value), bytes, extension: 'docx' });
    await expect(save('other')).rejects.toThrow('another user');
    await expect(save('owner', { ...session, expiresAt: 1 })).rejects.toThrow('expired');
    await expect(save('owner')).rejects.toThrow('original changed');
    expect(writes).toBe(0);
  });
});

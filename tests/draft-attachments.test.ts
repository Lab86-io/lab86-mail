import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import './tools/harness';
import { exportOfficePdf } from '../lib/documents/office-pdf';
import {
  checkDraftAttachments,
  DRAFT_ATTACHMENTS_MAX,
  DraftAttachmentError,
  draftAttachmentDeps,
  draftAttachmentsInputSchema,
  fillHeldAttachments,
  hasSealedAttachment,
  resolveDraftAttachments,
} from '../lib/files/draft-attachments';
import { SealedFileNeedsAllow } from '../lib/files/materialize';
import type { SavedFileRow } from '../lib/files/saved-files';
import type { DraftAttachment } from '../lib/shared/types';
import { getDraft } from '../lib/store/drafts';
import { saveDraftTool, updateDraft } from '../lib/tools/compose';
import { runTool, withToolContext } from './tools/harness';

// Invented data only.
const original = { ...draftAttachmentDeps };
afterEach(() => Object.assign(draftAttachmentDeps, original));

function upload(overrides: Partial<SavedFileRow> = {}): SavedFileRow {
  return {
    _id: 'upload_1',
    userId: 'test_user_tools',
    storageId: 's1',
    name: 'fw9 (filled).pdf',
    contentType: 'application/pdf',
    size: 1_000,
    createdAt: 1,
    url: 'https://storage.example.test/1',
    ...overrides,
  };
}

const officeFile = {
  documentId: 'office_1',
  title: 'Invoice 42',
  extension: 'docx' as const,
  currentRevision: 3,
  createdAt: 1,
  updatedAt: 1,
  versions: [],
  version: { revision: 3, url: 'https://storage.example.test/office', size: 2_000, sha256: 'x' },
};

const albatrossDoc = { documentId: 'doc_1', title: 'Timesheet', kind: 'sheet' };

function fake(overrides: Partial<typeof draftAttachmentDeps> = {}) {
  const calls: Record<string, unknown[][]> = {};
  const track =
    <T>(name: string, value: (...args: any[]) => T) =>
    (...args: any[]) => {
      calls[name] ??= [];
      calls[name].push(args);
      return value(...args);
    };
  Object.assign(draftAttachmentDeps, {
    getFile: track('getFile', async (_user: string, id: string) =>
      id === 'upload_1'
        ? upload()
        : id === 'sealed_1'
          ? upload({ _id: 'sealed_1', sealedFields: [{ field: 'tin', ref: '{{secure:si_x.number}}' }] })
          : id === 'notes_1'
            ? upload({ _id: 'notes_1', name: 'notes.csv', contentType: 'text/csv', size: 10 })
            : null,
    ),
    readBytes: track('readBytes', async () => new Uint8Array(1_000)),
    getOfficeFile: track('getOfficeFile', async (_user: string, id: string) =>
      id === 'office_1' ? officeFile : id === 'office_gone' ? { ...officeFile, version: null } : null,
    ),
    readOffice: track('readOffice', async () => new Uint8Array(2_000)),
    exportOfficePdf: track('exportOfficePdf', async () => ({
      bytes: new Uint8Array(500),
      name: 'Invoice 42.pdf',
    })),
    getDocument: track('getDocument', async (_user: string, id: string) =>
      id === 'doc_1' ? albatrossDoc : null,
    ),
    exportDocument: track('exportDocument', async () => ({
      bytes: new Uint8Array(300),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: 'xlsx',
      fidelity: 'full',
    })),
    checkSend: track('checkSend', async () => true),
    materialize: track('materialize', async () => ({
      bytes: new Uint8Array(1_200),
      name: 'fw9 (filled).pdf',
      contentType: 'application/pdf',
      sealed: true,
    })),
    ...overrides,
  } as Partial<typeof draftAttachmentDeps>);
  return calls;
}

describe('checking draft attachments', () => {
  test('each provider resolves to the user’s own file with its name, type, and size', async () => {
    fake();
    const list = await checkDraftAttachments('test_user_tools', [
      { fileId: 'upload_1', provider: 'upload' },
      { fileId: 'sealed_1', provider: 'upload', format: 'pdf', name: 'W-9 for Example Co.pdf' },
      { fileId: 'office_1', provider: 'office' },
      { fileId: 'office_1', provider: 'office', format: 'pdf' },
      { fileId: 'doc_1', provider: 'albatross', source: 'file' },
      { fileId: 'upload_1', provider: 'upload' },
    ]);
    expect(list).toEqual([
      {
        source: 'file',
        fileId: 'upload_1',
        provider: 'upload',
        format: 'native',
        name: 'fw9 (filled).pdf',
        size: 1_000,
        contentType: 'application/pdf',
      },
      {
        source: 'file',
        fileId: 'sealed_1',
        provider: 'upload',
        format: 'native',
        name: 'W-9 for Example Co.pdf',
        size: 1_000,
        contentType: 'application/pdf',
        sealed: true,
      },
      {
        source: 'file',
        fileId: 'office_1',
        provider: 'office',
        format: 'native',
        name: 'Invoice 42.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 2_000,
      },
      {
        source: 'file',
        fileId: 'office_1',
        provider: 'office',
        format: 'pdf',
        name: 'Invoice 42.pdf',
        contentType: 'application/pdf',
      },
      {
        source: 'file',
        fileId: 'doc_1',
        provider: 'albatross',
        format: 'native',
        name: 'Timesheet.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ]);
    expect(hasSealedAttachment(list)).toBe(true);
    expect(hasSealedAttachment(list.slice(0, 1))).toBe(false);
  });

  test('a file of another user, a wrong format, too many files, and no user are refused', async () => {
    fake();
    const refused = async (inputs: Parameters<typeof checkDraftAttachments>[1], user = 'test_user_tools') =>
      (await checkDraftAttachments(user, inputs).catch((error) => error)) as DraftAttachmentError;
    expect(await refused([{ fileId: 'theirs', provider: 'upload' }])).toMatchObject({
      status: 404,
      message: 'One of the files is not in Files any more.',
    });
    expect((await refused([{ fileId: 'notes_1', provider: 'upload', format: 'pdf' }])).message).toContain(
      'Only Word, Excel, and PowerPoint files convert to PDF.',
    );
    expect((await refused([{ fileId: 'office_x', provider: 'office' }])).status).toBe(404);
    expect((await refused([{ fileId: 'doc_x', provider: 'albatross' }])).status).toBe(404);
    expect((await refused([{ fileId: 'doc_1', provider: 'albatross', format: 'pdf' }])).message).toBe(
      'An Albatross document goes as a Word, Excel, or PowerPoint file.',
    );
    const eleven = Array.from({ length: DRAFT_ATTACHMENTS_MAX + 1 }, (_, index) => ({
      fileId: `upload_${index}`,
      provider: 'upload' as const,
    }));
    expect((await refused(eleven)).message).toBe('A mail takes 10 files at most.');
    expect((await refused([{ fileId: 'upload_1', provider: 'upload' }], '')).status).toBe(401);
    expect(draftAttachmentsInputSchema.safeParse(eleven).success).toBe(false);
  });
});

describe('resolving draft attachments at send time', () => {
  const all: DraftAttachment[] = [
    { source: 'file', fileId: 'upload_1', provider: 'upload', format: 'native', name: 'fw9.pdf' },
    { source: 'file', fileId: 'office_1', provider: 'office', format: 'native', name: 'Invoice 42.docx' },
    { source: 'file', fileId: 'office_1', provider: 'office', format: 'pdf', name: 'Invoice 42.pdf' },
    { source: 'file', fileId: 'doc_1', provider: 'albatross', format: 'native', name: '' },
  ];

  test('each provider reads bytes from storage; an office PDF calls the export', async () => {
    const calls = fake();
    const { attachments, held } = await resolveDraftAttachments('test_user_tools', all, {
      recipients: ['ap@example.com'],
    });
    expect(held).toEqual([]);
    expect(attachments.map(({ filename, contentType, size }) => ({ filename, contentType, size }))).toEqual([
      { filename: 'fw9.pdf', contentType: 'application/pdf', size: 1_000 },
      {
        filename: 'Invoice 42.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 2_000,
      },
      { filename: 'Invoice 42.pdf', contentType: 'application/pdf', size: 500 },
      {
        filename: 'Timesheet.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 300,
      },
    ]);
    expect(Buffer.isBuffer(attachments[0].content)).toBe(true);
    expect(calls.exportOfficePdf).toEqual([['test_user_tools', 'office_1']]);
    expect(calls.readOffice).toEqual([['https://storage.example.test/office']]);
  });

  test('a sealed file fills for the recipients now, or is held as a reference behind Undo', async () => {
    const calls = fake();
    const sealed: DraftAttachment[] = [
      {
        source: 'file',
        fileId: 'sealed_1',
        provider: 'upload',
        format: 'native',
        name: 'W-9.pdf',
        sealed: true,
      },
    ];
    const now = await resolveDraftAttachments('test_user_tools', sealed, {
      recipients: ['ap@example.com', undefined],
      workId: 'w1',
    });
    expect(now.attachments[0]).toMatchObject({
      filename: 'W-9.pdf',
      size: 1_200,
      contentType: 'application/pdf',
    });
    expect(calls.materialize).toEqual([
      [
        'test_user_tools',
        'sealed_1',
        { kind: 'send', recipients: ['ap@example.com', undefined], workId: 'w1' },
      ],
    ]);
    const later = await resolveDraftAttachments('test_user_tools', sealed, {
      recipients: ['ap@example.com'],
      hold: true,
    });
    expect(later).toEqual({ attachments: [], held: [{ fileId: 'sealed_1', filename: 'W-9.pdf' }] });
    expect(calls.checkSend).toEqual([['test_user_tools', 'sealed_1', ['ap@example.com']]]);
    expect(calls.materialize).toHaveLength(1);
    const filled = await fillHeldAttachments('test_user_tools', later.held, ['ap@example.com']);
    expect(filled[0]).toMatchObject({ filename: 'W-9.pdf', size: 1_200 });
    expect(calls.materialize[1]).toEqual([
      'test_user_tools',
      'sealed_1',
      { kind: 'send', recipients: ['ap@example.com'] },
    ]);
  });

  test('a blocked send, a missing file, and a mail over 25 MB stop the send', async () => {
    fake({
      checkSend: async () => {
        throw new SealedFileNeedsAllow([
          {
            itemId: 'si_x',
            itemLabel: 'Social Security number',
            fieldLabels: ['Number'],
            sites: ['example.org'],
          },
        ]);
      },
    });
    const sealed: DraftAttachment = {
      source: 'file',
      fileId: 'sealed_1',
      provider: 'upload',
      format: 'native',
      name: 'W-9.pdf',
    };
    await expect(
      resolveDraftAttachments('test_user_tools', [sealed], { recipients: ['a@example.org'], hold: true }),
    ).rejects.toBeInstanceOf(SealedFileNeedsAllow);
    const missing = (name: string, provider: DraftAttachment['provider'], fileId: string) =>
      resolveDraftAttachments(
        'test_user_tools',
        [{ source: 'file', fileId, provider, format: 'native', name }],
        {
          recipients: [],
        },
      );
    await expect(missing('a', 'upload', 'gone')).rejects.toMatchObject({ status: 404 });
    await expect(missing('a', 'office', 'office_gone')).rejects.toMatchObject({ status: 404 });
    await expect(missing('a', 'albatross', 'doc_x')).rejects.toMatchObject({ status: 404 });
    await expect(
      resolveDraftAttachments('test_user_tools', all.slice(0, 1), {
        recipients: [],
        usedBytes: 25 * 1024 * 1024 - 10,
      }),
    ).rejects.toMatchObject({
      status: 413,
      message: 'The files of this mail are larger than 25 MB together.',
    });
  });

  test('the default readers: the office version from storage, and the PDF export placeholder', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch,
    );
    try {
      expect([...(await original.readOffice('https://storage.example.test/office'))]).toEqual([1, 2, 3]);
      expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    } finally {
      fetchSpy.mockRestore();
    }
    await expect(exportOfficePdf('u1', 'office_1')).rejects.toThrow('PDF export is not ready.');
  });
});

describe('drafts keep their files', () => {
  test('save_draft checks the files; an edit without files keeps them; [] removes them', async () => {
    fake();
    const saved = await runTool(saveDraftTool.handler, {
      account: 'jakob@example.test',
      to: 'ap@example.com',
      subject: 'Invoice and W-9',
      body: 'Attached.',
      attachments: [
        { fileId: 'office_1', provider: 'office', format: 'pdf' },
        { fileId: 'sealed_1', provider: 'upload' },
      ],
    });
    expect(
      saved.draft.attachments.map((a: DraftAttachment) => [a.name, a.format, a.sealed ?? false]),
    ).toEqual([
      ['Invoice 42.pdf', 'pdf', false],
      ['fw9 (filled).pdf', 'native', true],
    ]);
    // The composers send text edits only: the files stay.
    await runTool(updateDraft.handler, { id: saved.draft._id, patch: { body: 'Attached, with the W-9.' } });
    const edited = await withToolContext(() => getDraft(saved.draft._id));
    expect(edited?.body).toBe('Attached, with the W-9.');
    expect(edited?.attachments).toHaveLength(2);
    await runTool(updateDraft.handler, {
      id: saved.draft._id,
      patch: { attachments: [{ fileId: 'upload_1', provider: 'upload' }] },
    });
    expect(
      (await withToolContext(() => getDraft(saved.draft._id)))?.attachments?.map((a) => a.fileId),
    ).toEqual(['upload_1']);
    await runTool(updateDraft.handler, { id: saved.draft._id, patch: { attachments: [] } });
    expect((await withToolContext(() => getDraft(saved.draft._id)))?.attachments).toBeUndefined();
    await expect(
      runTool(updateDraft.handler, {
        id: saved.draft._id,
        patch: { attachments: [{ fileId: 'theirs', provider: 'upload' }] },
      }),
    ).rejects.toThrow('not in Files');
    await expect(
      runTool(
        saveDraftTool.handler,
        {
          account: 'a',
          to: 'b',
          subject: 'c',
          body: 'd',
          attachments: [{ fileId: 'upload_1', provider: 'upload' }],
        },
        { userId: null },
      ),
    ).rejects.toThrow('Sign in required to attach files.');
    // A draft without files has no attachments field.
    const plain = await runTool(saveDraftTool.handler, { account: 'a', to: 'b', subject: 'c', body: 'd' });
    expect(plain.draft.attachments).toBeUndefined();
  });
});

import { afterEach, describe, expect, mock, test } from 'bun:test';
import './tools/harness';
import { z } from 'zod';
import { AGENT_TOOL_NAMES } from '../lib/ai/loop';
import {
  __setSavedFilesDepsForTest,
  SAVED_FILE_MAX_BYTES,
  SavedFileError,
  type SaveFileInput,
  sha256Hex,
} from '../lib/files/saved-files';
import type { Attachment } from '../lib/shared/types';
import { getTool } from '../lib/tools/index';
import { __setMailAttachmentSaveDepsForTest, mailAttachmentSave } from '../lib/tools/mail-attachments';
import { runTool } from './tools/harness';

afterEach(() => {
  __setMailAttachmentSaveDepsForTest();
  __setSavedFilesDepsForTest();
});

const ACCOUNT = 'acct-dana';
const MESSAGE_ID = 'msg-payer-1';
const ATTACHMENT_ID = 'att-w9';
const PDF = new TextEncoder().encode('%PDF-1.7 Form W-9 for Dana Example');
const HTML = new TextEncoder().encode('<!doctype html><html><body>Sign in</body></html>');
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode('payroll/notes.txt')]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    attachmentId: ATTACHMENT_ID,
    filename: 'W-9 Dana Example.pdf',
    mimeType: 'application/pdf',
    size: PDF.byteLength,
    ...overrides,
  };
}

function setup(
  options: {
    bytes?: Uint8Array;
    info?: Attachment | null;
    getMessage?: (...args: any[]) => Promise<any>;
    fetchError?: unknown;
  } = {},
) {
  const getMessage = mock(
    options.getMessage ??
      (async (..._args: any[]): Promise<any> =>
        options.info === null ? { attachments: [] } : { attachments: [options.info ?? attachment()] }),
  );
  const fetchEmailAttachment = mock(
    async (_userId: string, _account: string, _attachmentId: string, _messageId: string, name?: string) => {
      if (options.fetchError) throw options.fetchError;
      return {
        bytes: options.bytes ?? PDF,
        contentType: 'application/octet-stream',
        name: name || 'attachment',
      };
    },
  );
  const saves: SaveFileInput[] = [];
  const saveFileBytes = mock(async (input: SaveFileInput) => {
    saves.push(input);
    return {
      fileId: 'upload_7',
      title: input.name,
      openPath: '/?view=files&file=upload_7',
      size: input.bytes.byteLength,
      contentType: input.contentType,
      sha256: sha256Hex(input.bytes),
    };
  });
  __setMailAttachmentSaveDepsForTest({
    getMessage: getMessage as any,
    fetchEmailAttachment: fetchEmailAttachment as any,
    saveFileBytes,
  });
  return { getMessage, fetchEmailAttachment, saveFileBytes, saves };
}

const args = (overrides: Record<string, unknown> = {}) => ({
  account: ACCOUNT,
  messageId: MESSAGE_ID,
  attachmentId: ATTACHMENT_ID,
  ...overrides,
});

describe('mail_attachment_save', () => {
  test('is an agent tool that writes only the user’s own data', () => {
    expect(getTool('mail_attachment_save')).toBe(mailAttachmentSave as any);
    expect(AGENT_TOOL_NAMES.has('mail_attachment_save')).toBe(true);
    expect(mailAttachmentSave.category).toBe('mail');
    expect(mailAttachmentSave.mutating).toBe(true);
    expect(mailAttachmentSave.risk).toBe('write_self');
    // The OpenAI Responses API rejects patterns in a tool schema.
    expect(JSON.stringify(z.toJSONSchema(mailAttachmentSave.input))).not.toContain('pattern');
    expect(mailAttachmentSave.description).toContain('pdf_form_fill');
  });

  test('saves a PDF attachment with origin mail and the attachment name', async () => {
    const { getMessage, fetchEmailAttachment, saves } = setup();
    const result = await runTool(mailAttachmentSave.handler, args());
    expect(getMessage.mock.calls[0]).toEqual([
      { userId: 'test_user_tools', account: ACCOUNT, id: MESSAGE_ID },
    ]);
    expect(fetchEmailAttachment.mock.calls[0]).toEqual([
      'test_user_tools',
      ACCOUNT,
      ATTACHMENT_ID,
      MESSAGE_ID,
      'W-9 Dana Example.pdf',
    ]);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toEqual({
      userId: 'test_user_tools',
      bytes: PDF,
      name: 'W-9 Dana Example.pdf',
      contentType: 'application/pdf',
      origin: 'mail',
    });
    expect(result).toEqual({
      ok: true,
      fileId: 'upload_7',
      title: 'W-9 Dana Example.pdf',
      openPath: '/?view=files&file=upload_7',
      size: PDF.byteLength,
      contentType: 'application/pdf',
      sha256: sha256Hex(PDF),
    });
    expect('sourceUrl' in result).toBe(false);
  });

  test('a requested name gets the extension of the detected type', async () => {
    const { saves } = setup({
      info: attachment({ filename: 'scan0042', mimeType: 'application/octet-stream' }),
    });
    const result = await runTool(
      mailAttachmentSave.handler,
      args({ name: '  Direct Deposit Authorization ' }),
    );
    expect(saves[0].name).toBe('Direct Deposit Authorization.pdf');
    expect(result.title).toBe('Direct Deposit Authorization.pdf');
  });

  test('saves a CSV that the attachment name declares', async () => {
    const csv = new TextEncoder().encode('name,amount\nDana Example,120.00\n');
    const { saves } = setup({
      bytes: csv,
      info: attachment({ filename: 'payments.csv', mimeType: 'text/plain', size: csv.byteLength }),
    });
    await runTool(mailAttachmentSave.handler, args());
    expect(saves[0]).toMatchObject({ name: 'payments.csv', contentType: 'text/csv', origin: 'mail' });
  });

  test('the real store path registers the row with origin mail', async () => {
    const mutations: Array<Record<string, unknown>> = [];
    __setSavedFilesDepsForTest({
      convexMutation: (async (_fn: unknown, input: Record<string, unknown>) => {
        mutations.push(input);
        return mutations.length === 1 ? 'https://upload.example.com/1' : 'upload_9';
      }) as any,
      fetch: async () => Response.json({ storageId: 'storage_9' }),
    });
    // The real saveFileBytes, with stubbed storage.
    const stubs = setup();
    __setMailAttachmentSaveDepsForTest({
      getMessage: stubs.getMessage as any,
      fetchEmailAttachment: stubs.fetchEmailAttachment as any,
    });
    const result = await runTool(mailAttachmentSave.handler, args());
    expect(mutations[1]).toMatchObject({
      userId: 'test_user_tools',
      storageId: 'storage_9',
      name: 'W-9 Dana Example.pdf',
      contentType: 'application/pdf',
      origin: 'mail',
      sha256: sha256Hex(PDF),
    });
    expect(mutations[1]).not.toHaveProperty('sourceUrl');
    expect(result.fileId).toBe('upload_9');
  });

  test('without the message info, it uses the requested name and still checks the bytes', async () => {
    const { saves } = setup({
      getMessage: async () => {
        throw new Error('provider down');
      },
    });
    await runTool(mailAttachmentSave.handler, args({ name: 'Form W-9' }));
    expect(saves[0].name).toBe('Form W-9.pdf');
    const unnamed = setup({ info: null });
    await runTool(mailAttachmentSave.handler, args());
    expect(unnamed.saves[0].name).toBe('attachment.pdf');
  });

  test('refuses an HTML body and a zip body', async () => {
    const html = setup({ bytes: HTML, info: attachment({ filename: 'form.html', mimeType: 'text/html' }) });
    await expect(runTool(mailAttachmentSave.handler, args())).rejects.toThrow(
      'This attachment is a web page, not a supported file type. Allowed: PDF',
    );
    expect(html.saves).toHaveLength(0);
    const zip = setup({
      bytes: ZIP,
      info: attachment({ filename: 'forms.zip', mimeType: 'application/zip' }),
    });
    await expect(runTool(mailAttachmentSave.handler, args())).rejects.toThrow(
      'This zip file is not an Office file.',
    );
    expect(zip.saves).toHaveLength(0);
    setup({
      bytes: new TextEncoder().encode('just text'),
      info: attachment({ filename: 'notes.txt', mimeType: 'text/plain' }),
    });
    await expect(runTool(mailAttachmentSave.handler, args())).rejects.toThrow(
      'This file type is not allowed.',
    );
  });

  test('refuses a type that the attachment says and the bytes do not agree with', async () => {
    setup({ bytes: PNG });
    await expect(runTool(mailAttachmentSave.handler, args())).rejects.toThrow(
      'The file says it is PDF, but its contents are PNG.',
    );
  });

  test('refuses a file over 25 MB before and after the read', async () => {
    const early = setup({ info: attachment({ size: SAVED_FILE_MAX_BYTES + 1 }) });
    await expect(runTool(mailAttachmentSave.handler, args())).rejects.toThrow(
      'The attachment is larger than 25 MB.',
    );
    expect(early.fetchEmailAttachment).not.toHaveBeenCalled();
    setup({ fetchError: new Error('Attachment is too large (max 25 MB).') });
    await expect(runTool(mailAttachmentSave.handler, args())).rejects.toThrow(
      'The attachment is larger than 25 MB.',
    );
    const big = new Uint8Array(SAVED_FILE_MAX_BYTES + 1);
    big.set(PDF);
    const late = setup({ bytes: big, info: null });
    await expect(runTool(mailAttachmentSave.handler, args())).rejects.toThrow(
      'The attachment is larger than 25 MB.',
    );
    expect(late.saves).toHaveLength(0);
  });

  test('maps read and store errors to plain sentences', async () => {
    setup({ fetchError: new Error('Email account not connected, or attachment not found.') });
    await expect(runTool(mailAttachmentSave.handler, args())).rejects.toThrow(
      'No attachment has this id, or the mailbox is not connected.',
    );
    setup({ fetchError: Object.assign(new Error('Nylas API error'), { statusCode: 404 }) });
    await expect(runTool(mailAttachmentSave.handler, args())).rejects.toThrow(
      'No attachment has this id, or the mailbox is not connected.',
    );
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      setup({ fetchError: Object.assign(new Error('upstream exploded'), { statusCode: 502 }) });
      await expect(runTool(mailAttachmentSave.handler, args())).rejects.toThrow(
        'The mail provider did not give the attachment. Try again later.',
      );
      setup({ fetchError: 'socket closed' });
      await expect(runTool(mailAttachmentSave.handler, args())).rejects.toThrow(
        'The mail provider did not give the attachment. Try again later.',
      );
    } finally {
      console.warn = warn;
    }
    setup({ bytes: new Uint8Array() });
    await expect(runTool(mailAttachmentSave.handler, args())).rejects.toThrow('The attachment is empty.');

    const stored = setup();
    stored.saveFileBytes.mockImplementation(async () => {
      throw new SavedFileError('The file could not be stored.');
    });
    await expect(runTool(mailAttachmentSave.handler, args())).rejects.toThrow(
      'The file could not be stored.',
    );
    const other = setup();
    const boom = new TypeError('unexpected');
    other.saveFileBytes.mockImplementation(async () => {
      throw boom;
    });
    await expect(runTool(mailAttachmentSave.handler, args())).rejects.toBe(boom);
  });

  test('needs a signed-in user', async () => {
    const { fetchEmailAttachment } = setup();
    await expect(runTool(mailAttachmentSave.handler, args(), { userId: null })).rejects.toThrow(
      'Sign in to save a file.',
    );
    expect(fetchEmailAttachment).not.toHaveBeenCalled();
  });
});

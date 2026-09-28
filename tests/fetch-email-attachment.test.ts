import { describe, expect, mock, test } from 'bun:test';
import { fetchEmailAttachment } from '../lib/attachments/fetch-store';
import { AttachmentTooLargeError } from '../lib/attachments/mail-files';

describe('fetchEmailAttachment', () => {
  test('reads through the shared attachment path with lazy fill and the 25 MB cap', async () => {
    const read = mock(
      async (..._args: any[]): Promise<any> => ({
        bytes: new Uint8Array([1, 2, 3]),
        source: 'store',
        filename: 'stored.pdf',
      }),
    );
    const blob = await fetchEmailAttachment('u1', 'acct', 'a1', 'm1', 'Plan.pdf', {
      readMailAttachmentBytes: read,
    });
    expect(blob).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'application/octet-stream',
      name: 'Plan.pdf',
    });
    expect(read.mock.calls[0]).toEqual([
      { userId: 'u1', account: 'acct', attachmentId: 'a1', messageId: 'm1' },
      { fill: 'always', maxBytes: 25 * 1024 * 1024 },
    ]);
    const unnamed = await fetchEmailAttachment('u1', 'acct', 'a1', 'm1', undefined, {
      readMailAttachmentBytes: read,
    });
    expect(unnamed.name).toBe('attachment');
  });

  test('a missing file or mailbox, a file over the cap, and other errors', async () => {
    const missing = mock(async (): Promise<any> => null);
    await expect(
      fetchEmailAttachment('u1', 'acct', 'a1', 'm1', undefined, { readMailAttachmentBytes: missing }),
    ).rejects.toThrow('Email account not connected, or attachment not found.');
    const big = mock(async (): Promise<any> => {
      throw new AttachmentTooLargeError(25 * 1024 * 1024);
    });
    await expect(
      fetchEmailAttachment('u1', 'acct', 'a1', 'm1', undefined, { readMailAttachmentBytes: big }),
    ).rejects.toThrow('Attachment is too large (max 25 MB).');
    const down = mock(async (): Promise<any> => {
      throw new Error('provider down');
    });
    await expect(
      fetchEmailAttachment('u1', 'acct', 'a1', 'm1', undefined, { readMailAttachmentBytes: down }),
    ).rejects.toThrow('provider down');
  });
});

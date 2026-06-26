import { describe, expect, test } from 'bun:test';
import {
  emailList,
  normalizeNylasAccount,
  normalizeNylasAttachment,
  normalizeNylasFolder,
  normalizeNylasMessage,
  normalizeNylasThread,
} from '../lib/nylas/normalize';

describe('normalizeNylasAccount', () => {
  test('maps connected grants to local account rows', () => {
    expect(
      normalizeNylasAccount({
        accountId: 'acct_1',
        email: 'jakob@example.test',
        provider: 'google',
        status: 'connected',
        displayName: 'Jakob',
        grantId: 'grant_1',
      }),
    ).toMatchObject({
      accountId: 'acct_1',
      email: 'jakob@example.test',
      authed: true,
      services: ['nylas', 'google'],
    });
  });
});

describe('normalizeNylasThread', () => {
  test('derives thread metadata from Nylas payloads', () => {
    const thread = normalizeNylasThread(
      {
        id: 'thread_1',
        subject: 'Hello',
        snippet: 'Preview',
        unread: true,
        starred: false,
        folders: ['INBOX'],
        latestMessageReceivedDate: 1_700_000_000,
        latestDraftOrMessage: {
          subject: 'Hello',
          snippet: 'Preview',
          from: [{ email: 'ada@example.test', name: 'Ada' }],
        },
      } as any,
      'grant_1',
    );
    expect(thread).toMatchObject({
      _id: 'thread_1',
      account: 'grant_1',
      subject: 'Hello',
      unread: true,
      labels: ['INBOX'],
    });
    expect(thread.lastDate).toBe(1_700_000_000_000);
  });
});

describe('normalizeNylasMessage', () => {
  test('converts HTML bodies to text and preserves headers', () => {
    const message = normalizeNylasMessage(
      {
        id: 'msg_1',
        threadId: 'thread_1',
        subject: 'Invoice',
        date: 1_700_000_000,
        body: '<p>Payment due</p>',
        from: [{ email: 'billing@example.test', name: 'Billing' }],
        to: [{ email: 'jakob@example.test' }],
        headers: [{ name: 'Message-ID', value: '<abc@example.test>' }],
        attachments: [{ id: 'att_1', filename: 'invoice.pdf', contentType: 'application/pdf', size: 1024 }],
      } as any,
      'grant_1',
    );
    expect(message.textBody).toContain('Payment due');
    expect(message.headers['message-id']).toBe('<abc@example.test>');
    expect(message.attachments[0]).toMatchObject({
      filename: 'invoice.pdf',
      attachmentId: 'att_1',
    });
  });
});

describe('normalizeNylasAttachment', () => {
  test('normalizes mixed attachment field names', () => {
    expect(
      normalizeNylasAttachment({
        name: 'photo.jpg',
        content_type: 'image/jpeg',
        attachment_id: 'att_2',
        size: 2048,
      }),
    ).toMatchObject({
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      attachmentId: 'att_2',
      size: 2048,
    });
  });
});

describe('normalizeNylasFolder', () => {
  test('marks system folders and preserves counts', () => {
    expect(
      normalizeNylasFolder({
        id: 'INBOX',
        name: 'Inbox',
        systemFolder: true,
        totalCount: 42,
      }),
    ).toMatchObject({
      id: 'INBOX',
      type: 'system',
      messagesTotal: 42,
    });
  });
});

describe('emailList', () => {
  test('parses comma-separated header values', () => {
    expect(emailList('"Ada" <ada@example.test>, bob@example.test')).toEqual([
      { name: 'Ada', email: 'ada@example.test' },
      { email: 'bob@example.test' },
    ]);
  });
});

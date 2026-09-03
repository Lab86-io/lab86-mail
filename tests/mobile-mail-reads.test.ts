import { describe, expect, test } from 'bun:test';
import { MobileInputError } from '../lib/mobile/v1/http';
import { mailListCursor, mailListLimit, mailThreadDetailFromTool } from '../lib/mobile/v1/mail-reads';

describe('mailThreadDetailFromTool', () => {
  test('orders messages by sentAt regardless of the tool order and drops id-less rows', () => {
    const detail = mailThreadDetailFromTool(
      {
        subject: 'Trip',
        summary: 'Two replies',
        messages: [
          { _id: 'm3', date: 3_000, from: 'C <c@example.com>', textBody: 'third' },
          { date: 1_500, from: 'ghost@example.com', textBody: 'no id' },
          { id: 'm1', date: 1_000, from: 'A <a@example.com>', textBody: 'first' },
          { _id: 'm2', date: 2_000, from: 'B <b@example.com>', textBody: 'second', unread: true },
        ],
      },
      'account-1',
      'thread-1',
    );
    expect(detail.threadID).toBe('thread-1');
    expect(detail.accountID).toBe('account-1');
    expect(detail.subject).toBe('Trip');
    expect(detail.summary).toBe('Two replies');
    expect(detail.messages.map((message) => message.id)).toEqual(['m1', 'm2', 'm3']);
    expect(detail.messages[0].fromEmail).toBe('a@example.com');
    expect(detail.messages[1].unread).toBe(true);
    expect(detail.messages.every((message) => message.threadID === 'thread-1')).toBe(true);
  });

  test('coerces missing and malformed fields into the strict schema', () => {
    const detail = mailThreadDetailFromTool(
      {
        messages: [
          {
            _id: 'm1',
            date: 'not-a-date',
            attachments: [
              { id: 'a1', filename: 'deck.pdf', contentType: 'application/pdf', size: '12' },
              { name: 'no-id.png' },
              { attachmentId: 'a2', size: -5 },
            ],
            htmlBody: null,
          },
        ],
      },
      'account-1',
      'thread-1',
    );
    expect(detail.subject).toBe('(no subject)');
    expect(detail.summary).toBeUndefined();
    const [message] = detail.messages;
    expect(message.subject).toBe('(no subject)');
    expect(message.sentAt).toBe(0);
    expect(message.bodyHTML).toBeUndefined();
    expect(message.attachments).toEqual([
      { id: 'a1', name: 'deck.pdf', contentType: 'application/pdf', size: 12 },
      { id: 'a2', name: 'attachment', contentType: 'application/octet-stream', size: undefined },
    ]);
  });

  test('tolerates a tool result without messages', () => {
    const detail = mailThreadDetailFromTool({ subject: 'Empty' }, 'account-1', 'thread-1');
    expect(detail.messages).toEqual([]);
  });
});

describe('mailListCursor', () => {
  test('absent cursors mean the first page', () => {
    expect(mailListCursor(null)).toBeUndefined();
    expect(mailListCursor('')).toBeUndefined();
  });

  test('parses a decimal epoch-ms watermark', () => {
    expect(mailListCursor('1754000000000')).toBe(1_754_000_000_000);
    expect(mailListCursor('0')).toBe(0);
  });

  test('rejects anything that is not a digit string as client input', () => {
    for (const raw of ['-1', '1.5', 'abc', '1e3', ' 12', '12 ']) {
      expect(() => mailListCursor(raw)).toThrow(MobileInputError);
    }
  });

  test('rejects watermarks beyond the safe integer range', () => {
    expect(() => mailListCursor('99999999999999999999')).toThrow(MobileInputError);
  });
});

describe('mailListLimit', () => {
  test('defaults to 50 and clamps into 1..100', () => {
    expect(mailListLimit(null)).toBe(50);
    expect(mailListLimit('')).toBe(50);
    expect(mailListLimit('25')).toBe(25);
    expect(mailListLimit('25.9')).toBe(25);
    expect(mailListLimit('0')).toBe(1);
    expect(mailListLimit('-7')).toBe(1);
    expect(mailListLimit('1000')).toBe(100);
  });

  test('falls back to the default for non-numeric input', () => {
    expect(mailListLimit('many')).toBe(50);
    expect(mailListLimit('Infinity')).toBe(50);
  });
});

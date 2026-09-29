import { describe, expect, test } from 'bun:test';
import {
  ATTACHMENT_INLINE_MIN_BYTES,
  ATTACHMENT_STORE_MAX_BYTES,
  ATTACHMENT_STORE_MAX_FILES_PER_MESSAGE,
  ATTACHMENT_STORE_WINDOW_DAYS,
  ATTACHMENT_STORE_WINDOW_MS,
  attachmentMimeBase,
  attachmentSizeSkipReason,
  isInlinePart,
  messageSkipReason,
  queueableAttachments,
  queueSkipReason,
} from '../lib/attachments/store-policy';

const NOW = Date.UTC(2026, 8, 28);
const DAY = 86_400_000;
const fresh = { receivedAt: NOW - DAY, labels: ['INBOX'] };

describe('attachment storage policy', () => {
  test('the policy constants are 60 days, 25 MB, and 4 KB', () => {
    expect(ATTACHMENT_STORE_WINDOW_DAYS).toBe(60);
    expect(ATTACHMENT_STORE_WINDOW_MS).toBe(60 * DAY);
    expect(ATTACHMENT_STORE_MAX_BYTES).toBe(25 * 1024 * 1024);
    expect(ATTACHMENT_INLINE_MIN_BYTES).toBe(4096);
  });

  test('mime base drops parameters and case', () => {
    expect(attachmentMimeBase('Image/PNG; name="a.png"')).toBe('image/png');
    expect(attachmentMimeBase(undefined)).toBe('');
  });

  test('the provider flag decides inline; with no flag an image counts as inline', () => {
    expect(isInlinePart({ mimeType: 'image/gif' })).toBe(true);
    expect(isInlinePart({ mimeType: 'application/pdf' })).toBe(false);
    expect(isInlinePart({ mimeType: 'image/gif', isInline: false })).toBe(false);
    expect(isInlinePart({ mimeType: 'text/calendar', isInline: true })).toBe(true);
  });

  test('size rules: over the cap, and small inline parts', () => {
    expect(
      attachmentSizeSkipReason({ size: ATTACHMENT_STORE_MAX_BYTES + 1, mimeType: 'application/pdf' }),
    ).toBe('too_large');
    expect(
      attachmentSizeSkipReason({ size: ATTACHMENT_STORE_MAX_BYTES, mimeType: 'application/pdf' }),
    ).toBeNull();
    expect(attachmentSizeSkipReason({ size: 43, mimeType: 'image/gif' })).toBe('small_inline');
    expect(attachmentSizeSkipReason({ size: 4095, mimeType: 'image/png; name=x' })).toBe('small_inline');
    expect(attachmentSizeSkipReason({ size: 4096, mimeType: 'image/png' })).toBeNull();
    // A small real file (an invitation) is kept; an unknown size is checked after the download.
    expect(attachmentSizeSkipReason({ size: 900, mimeType: 'text/calendar' })).toBeNull();
    expect(attachmentSizeSkipReason({ size: 0, mimeType: 'image/png' })).toBeNull();
    expect(attachmentSizeSkipReason({ size: 900, mimeType: 'image/png', isInline: false })).toBeNull();
  });

  test('message rules: the time window, and no spam or trash for any provider', () => {
    expect(messageSkipReason(fresh, NOW)).toBeNull();
    expect(messageSkipReason({ receivedAt: NOW - 60 * DAY }, NOW)).toBeNull();
    expect(messageSkipReason({ receivedAt: NOW - 60 * DAY - 1 }, NOW)).toBe('outside_window');
    expect(messageSkipReason({ receivedAt: Number.NaN }, NOW)).toBe('outside_window');
    expect(messageSkipReason({ receivedAt: NOW, labels: ['SPAM'] }, NOW)).toBe('spam_or_trash');
    expect(messageSkipReason({ receivedAt: NOW, labels: ['Deleted Items'] }, NOW)).toBe('spam_or_trash');
    expect(messageSkipReason({ receivedAt: NOW, labels: ['Junk Email'] }, NOW)).toBe('spam_or_trash');
  });

  test('queue skip reason checks the id, then the message, then the size', () => {
    expect(queueSkipReason({ size: 10 }, fresh, NOW)).toBe('no_id');
    expect(queueSkipReason({ attachmentId: 'a', size: 10 }, { receivedAt: 0 }, NOW)).toBe('outside_window');
    expect(queueSkipReason({ attachmentId: 'a', size: 10, mimeType: 'image/png' }, fresh, NOW)).toBe(
      'small_inline',
    );
    expect(
      queueSkipReason({ attachmentId: 'a', size: 10_000, mimeType: 'image/png' }, fresh, NOW),
    ).toBeNull();
  });

  test('queueable attachments of a stored message', () => {
    const files = queueableAttachments(
      {
        ...fresh,
        attachments: [
          { attachmentId: 'pdf', filename: 'Invoice.pdf', mimeType: 'application/pdf', size: 90_000 },
          { attachmentId: 'pdf', filename: 'Invoice.pdf', mimeType: 'application/pdf', size: 90_000 },
          { attachmentId: 'pixel', filename: 'p.gif', mimeType: 'image/gif', size: 43 },
          { id: 'legacy', name: 'notes.txt', content_type: 'text/plain', size: '12' },
          { attachmentId: 'flagged', contentType: 'image/png', size: 100, is_inline: false },
          { attachmentId: 'huge', mimeType: 'video/mp4', size: ATTACHMENT_STORE_MAX_BYTES + 1 },
          { filename: 'no-id.pdf', size: 10 },
          null,
          'junk',
        ],
      },
      NOW,
    );
    expect(files).toEqual([
      { attachmentId: 'pdf', filename: 'Invoice.pdf', mimeType: 'application/pdf', size: 90_000 },
      { attachmentId: 'legacy', filename: 'notes.txt', mimeType: 'text/plain', size: 12 },
      { attachmentId: 'flagged', filename: 'attachment', mimeType: 'image/png', size: 100 },
    ]);
  });

  test('no read for mail with no attachments, old mail, or spam; at most 20 files', () => {
    expect(queueableAttachments({ ...fresh }, NOW)).toEqual([]);
    expect(queueableAttachments({ ...fresh, attachments: 'x' as any }, NOW)).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => ({
      attachmentId: `a${i}`,
      mimeType: 'application/pdf',
      size: 10_000,
    }));
    expect(queueableAttachments({ receivedAt: 0, attachments: many }, NOW)).toEqual([]);
    expect(queueableAttachments({ ...fresh, labels: ['TRASH'], attachments: many }, NOW)).toEqual([]);
    expect(queueableAttachments({ ...fresh, attachments: many }, NOW)).toHaveLength(
      ATTACHMENT_STORE_MAX_FILES_PER_MESSAGE,
    );
    const long = queueableAttachments(
      {
        ...fresh,
        attachments: [{ attachmentId: 'l', filename: 'x'.repeat(900), mimeType: 'y'.repeat(400) }],
      },
      NOW,
    );
    expect(long[0].filename).toHaveLength(500);
    expect(long[0].mimeType).toHaveLength(255);
  });
});

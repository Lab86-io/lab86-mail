import { describe, expect, test } from 'bun:test';
import {
  attachmentPreviewKind,
  buildAttachmentPreviewItem,
  canEmbedAttachmentPreview,
} from '../components/thread/attachment-preview';

describe('attachment preview classification', () => {
  test.each([
    ['image/png', 'photo.png', 'image'],
    ['application/pdf', 'brief.pdf', 'pdf'],
    ['text/plain', 'notes.txt', 'text'],
    ['application/json', 'data.json', 'code'],
    ['text/csv', 'report.csv', 'text'],
    ['video/mp4', 'clip.mp4', 'video'],
    ['audio/mpeg', 'voice.mp3', 'audio'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'plan.docx', 'office'],
    ['application/zip', 'archive.zip', 'archive'],
    ['text/calendar', 'invite.ics', 'calendar'],
    ['message/rfc822', 'forward.eml', 'email'],
    ['', 'mystery.bin', 'unknown'],
  ] as const)('maps %s / %s to %s', (mime, filename, expected) => {
    expect(attachmentPreviewKind(mime, filename)).toBe(expected);
  });

  test('builds stable preview metadata and embed flags', () => {
    const item = buildAttachmentPreviewItem({
      filename: 'agenda.ics',
      mimeType: '',
      size: 2048,
      downloadHref: '/download',
      previewHref: '/preview',
    });
    expect(item.previewKind).toBe('calendar');
    expect(item.meta).toContain('Calendar');
    expect(item.meta).toContain('2.0 KB');
    expect(canEmbedAttachmentPreview(item.previewKind)).toBe(true);
    expect(canEmbedAttachmentPreview('office')).toBe(false);
  });
});

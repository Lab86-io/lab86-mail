import { describe, expect, test } from 'bun:test';
import { documentDeepLinkUrl } from '../lib/documents/deep-link';
import { formatBytes, sanitizeFilename } from '../lib/shared/files';

describe('sanitizeFilename', () => {
  test('removes forbidden characters and control chars', () => {
    expect(sanitizeFilename('report:final?.pdf')).toBe('report_final_.pdf');
    expect(sanitizeFilename('\u0007hidden.txt')).toBe('hidden.txt');
  });
  test('strips leading dots and caps length', () => {
    expect(sanitizeFilename('...secret')).toBe('secret');
    expect(sanitizeFilename('a'.repeat(300)).length).toBe(200);
  });
  test('falls back to attachment', () => {
    expect(sanitizeFilename('')).toBe('attachment');
    expect(sanitizeFilename('...')).toBe('attachment');
  });
});

describe('formatBytes', () => {
  test('formats common sizes', () => {
    expect(formatBytes(0)).toBe('');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
  test('returns empty for negative values', () => {
    expect(formatBytes(-1)).toBe('');
  });
});

describe('document file deep links', () => {
  test('preserves unrelated location state while selecting Files and one encoded document', () => {
    expect(
      documentDeepLinkUrl(
        'document/with spaces',
        'https://mail.example.test/?view=today&account=primary#inbox',
      ),
    ).toBe('/?view=files&account=primary&document=document%2Fwith+spaces#inbox');
  });
});

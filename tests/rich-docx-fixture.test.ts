import { expect, test } from 'bun:test';
import JSZip from 'jszip';
import { buildRichDocxFixture } from '../lib/documents/rich-docx-fixture';

test('the rich Word fixture carries a table, an image, comments, a header, a footer and two pages', async () => {
  const bytes = await buildRichDocxFixture();
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files);
  const document = await zip.file('word/document.xml')!.async('string');
  expect(document).toContain('<w:tbl>');
  expect(document).toContain('<w:drawing>');
  expect(document).toContain('w:commentRangeStart');
  expect(document).toContain('<w:br w:type="page"/>');
  expect(names.some((name) => name.startsWith('word/media/'))).toBe(true);
  expect(names.some((name) => /^word\/header\d*\.xml$/.test(name))).toBe(true);
  expect(names.some((name) => /^word\/footer\d*\.xml$/.test(name))).toBe(true);
  const comments = await zip.file('word/comments.xml')?.async('string');
  expect(comments).toContain('treasurer report');
  expect(bytes.length).toBeGreaterThan(4_000);
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AREA_IMAGE_MAX_BYTES,
  orderedAreaImageSources,
  validateAreaImageUpload,
} from '../lib/albatross/area-image';

describe('Area image upload contract', () => {
  test('accepts bounded images', () => {
    expect(() => validateAreaImageUpload({ contentType: 'image/webp', size: 256_000 })).not.toThrow();
  });

  test('rejects non-images, empty files, and oversized images', () => {
    expect(() => validateAreaImageUpload({ contentType: 'application/pdf', size: 10 })).toThrow(
      'Choose an image file.',
    );
    expect(() => validateAreaImageUpload({ contentType: 'image/png', size: 0 })).toThrow(
      'The image is empty.',
    );
    expect(() =>
      validateAreaImageUpload({ contentType: 'image/png', size: AREA_IMAGE_MAX_BYTES + 1 }),
    ).toThrow('Area images must be 8MB or smaller.');
  });

  test('replacement and removal delete superseded storage plus its upload record', () => {
    const source = readFileSync(path.join(process.cwd(), 'convex/albatross.ts'), 'utf8');
    const mutation = source.slice(
      source.indexOf('export const setAreaImage'),
      source.indexOf('export const archiveArea'),
    );
    expect(mutation).toContain(".query('agentUploads')");
    expect(mutation).toContain('ctx.db.delete(previousUpload._id)');
    expect(mutation).toContain('ctx.storage.delete(previousStorageId)');
  });
});

describe('orderedAreaImageSources', () => {
  test('prefers the area image over its favicon', () => {
    expect(
      orderedAreaImageSources({
        imageUrl: 'https://example.com/image.png',
        faviconUrl: 'https://example.com/favicon.ico',
      }),
    ).toEqual(['https://example.com/image.png', 'https://example.com/favicon.ico']);
  });

  test('drops blank/whitespace-only values and falls back to whatever is left', () => {
    expect(
      orderedAreaImageSources({ imageUrl: '   ', faviconUrl: 'https://example.com/favicon.ico' }),
    ).toEqual(['https://example.com/favicon.ico']);
    expect(orderedAreaImageSources({ imageUrl: 'https://example.com/image.png', faviconUrl: null })).toEqual([
      'https://example.com/image.png',
    ]);
    expect(orderedAreaImageSources({ imageUrl: null, faviconUrl: undefined })).toEqual([]);
  });
});

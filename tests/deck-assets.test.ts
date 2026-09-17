import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  __setDeckAssetDepsForTest,
  DeckAssetError,
  MAX_DECK_ASSET_BYTES,
  sniffImageMime,
  storeDeckAsset,
} from '../lib/documents/deck-asset-store';

// A PNG signature and an IHDR block declaring 1200 by 800 pixels.
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x04, 0xb0, 0, 0,
  0x03, 0x20, 8, 6, 0, 0, 0,
]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]);

describe('deck assets', () => {
  afterEach(() => __setDeckAssetDepsForTest());
  test('the image type comes from the signature, never the declared type', () => {
    expect(sniffImageMime(png)).toBe('image/png');
    expect(sniffImageMime(jpeg)).toBe('image/jpeg');
    expect(sniffImageMime(webp)).toBe('image/webp');
    expect(sniffImageMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageMime(new Uint8Array([1, 2, 3]))).toBeNull();
  });
  test('rejects empty, oversized, unknown and unreadable uploads before storage', async () => {
    let uploads = 0;
    __setDeckAssetDepsForTest({
      convexMutation: async () => {
        uploads += 1;
        return 'https://upload.example' as never;
      },
      measure: async () => {
        throw new Error('bad');
      },
    });
    await expect(storeDeckAsset('u', new Uint8Array())).rejects.toBeInstanceOf(DeckAssetError);
    await expect(storeDeckAsset('u', new Uint8Array(MAX_DECK_ASSET_BYTES + 1))).rejects.toMatchObject({
      status: 413,
    });
    await expect(storeDeckAsset('u', new TextEncoder().encode('plain text file'))).rejects.toMatchObject({
      status: 415,
    });
    await expect(storeDeckAsset('u', png)).rejects.toMatchObject({ status: 415 });
    expect(uploads).toBe(0);
  });
  test('stores a valid image, records its size and hash, and returns a stable source', async () => {
    const calls: Array<{ args: Record<string, unknown> }> = [];
    __setDeckAssetDepsForTest({
      measure: async () => ({ width: 1200, height: 800 }),
      convexMutation: async (_fn: unknown, args: Record<string, unknown>) => {
        calls.push({ args });
        if (calls.length === 1) return 'https://upload.example/one' as never;
        return {
          assetId: 'asset_1',
          url: 'https://precise-skunk-847.convex.cloud/api/storage/abc',
          width: args.width,
          height: args.height,
          mime: args.mime,
          size: args.size,
        } as never;
      },
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe('https://upload.example/one');
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers['Content-Type']).toBe('image/png');
        return new Response(JSON.stringify({ storageId: 'st_1' }), { status: 200 });
      },
    });
    const asset = await storeDeckAsset('user-1', png);
    expect(asset).toMatchObject({
      assetId: 'asset_1',
      width: 1200,
      height: 800,
      aspect: 1.5,
      mime: 'image/png',
      size: png.length,
    });
    expect(asset.src.startsWith('https://')).toBe(true);
    expect(calls[1].args).toMatchObject({
      userId: 'user-1',
      storageId: 'st_1',
      mime: 'image/png',
      width: 1200,
      height: 800,
    });
    expect(String(calls[1].args.sha256)).toHaveLength(64);
  });
});

describe('image dimensions from headers', () => {
  test('reads PNG, GIF, WebP and JPEG sizes without decoding, and refuses oversized images before decode', async () => {
    const { imageDimensionsFromHeader, storeDeckAsset, __setDeckAssetDepsForTest } = await import(
      '../lib/documents/deck-asset-store'
    );
    const pngHeader = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x03, 0x20,
      0, 0, 0x01, 0xc2, 8, 6, 0, 0, 0,
    ]);
    expect(imageDimensionsFromHeader(pngHeader)).toEqual({ width: 800, height: 450 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00, 0, 0]);
    expect(imageDimensionsFromHeader(gif)).toEqual({ width: 320, height: 240 });
    const jpeg = readFileSync('public/art/fallback-1.jpg');
    expect(imageDimensionsFromHeader(new Uint8Array(jpeg))).toEqual({ width: 600, height: 449 });
    const webp = new Uint8Array(32);
    webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20], 0);
    webp[26] = 0x40;
    webp[27] = 0x01;
    webp[28] = 0xf0;
    webp[29] = 0x00;
    expect(imageDimensionsFromHeader(webp)).toEqual({ width: 320, height: 240 });
    // Oversized by header: no decode call reaches measure.
    const huge = new Uint8Array(pngHeader);
    huge[16] = 0;
    huge[17] = 0;
    huge[18] = 0x30;
    huge[19] = 0x00; // 12288 px wide
    let decoded = 0;
    __setDeckAssetDepsForTest({
      measure: async () => {
        decoded += 1;
        return { width: 1, height: 1 };
      },
    });
    try {
      await expect(storeDeckAsset('u', huge)).rejects.toMatchObject({ status: 413 });
      expect(decoded).toBe(0);
    } finally {
      __setDeckAssetDepsForTest();
    }
  });
});

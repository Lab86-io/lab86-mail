import { describe, expect, test } from 'bun:test';
import { loadDeckAsset } from '../lib/documents/deck-assets';

describe('owned asset loading for export', () => {
  test('reads a relative path under public and reports its type', async () => {
    const asset = await loadDeckAsset('/art/fallback-1.jpg');
    expect(asset.mime).toBe('image/jpeg');
    expect(asset.data.startsWith('image/jpeg;base64,')).toBe(true);
    expect(asset.bytes).toBeGreaterThan(1_000);
  });
  test('refuses paths that escape public and hosts that are not owned storage', async () => {
    await expect(loadDeckAsset('/../package.json')).rejects.toThrow('escapes');
    await expect(loadDeckAsset('https://example.com/image.png')).rejects.toThrow('owned storage');
    await expect(loadDeckAsset('http://precise-skunk-847.convex.cloud/x.png')).rejects.toThrow(
      'owned storage',
    );
    await expect(loadDeckAsset('//evil.example/x.png')).rejects.toThrow();
  });
});

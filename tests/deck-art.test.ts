import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  __setDeckArtDepsForTest,
  candidateFromPiece,
  importArtwork,
  isAllowedArtworkImage,
  prepareArtworkImage,
  scoreArtwork,
  searchArtLive,
  searchArtPool,
  searchArtworks,
  stylesForDirection,
} from '../lib/documents/deck-art';
import { ART_POOL } from '../lib/mail/daily-art-pool';

describe('artwork search over the curated pool', () => {
  test('style, words and hue all pull matching pieces to the top, deterministically per seed', () => {
    const impressionist = searchArtPool({ styles: ['impressionist'], count: 6, seed: 'a' });
    expect(impressionist).toHaveLength(6);
    expect(impressionist.every((c) => c.style === 'impressionist')).toBe(true);
    const again = searchArtPool({ styles: ['impressionist'], count: 6, seed: 'a' });
    expect(again.map((c) => c.key)).toEqual(impressionist.map((c) => c.key));
    const other = searchArtPool({ styles: ['impressionist'], count: 6, seed: 'b' });
    expect(other.map((c) => c.key)).not.toEqual(impressionist.map((c) => c.key));
    const landscapes = searchArtPool({ text: 'landscape river', count: 5 });
    expect(landscapes.length).toBeGreaterThan(0);
    expect(landscapes.every((c) => /landscape|river/i.test(c.title))).toBe(true);
    const warm = searchArtPool({ accentHue: 30, count: 5 });
    expect(warm.every((c) => typeof c.accentHue === 'number')).toBe(true);
    const all = searchArtPool({ count: 40 });
    expect(all).toHaveLength(40);
  });
  test('candidates carry attribution and full-size image addresses from the pool', () => {
    const met = ART_POOL.find((piece) => piece.source === 'met')!;
    const candidate = candidateFromPiece(met);
    expect(candidate.credit).toContain(met.title);
    expect(candidate.imageUrl).toContain('/original/');
    expect(candidate.license).toBe('Public domain');
    expect(scoreArtwork(candidate, { styles: [met.style] })).toBeGreaterThanOrEqual(3);
    expect(scoreArtwork(candidate, {})).toBe(0);
    expect(isAllowedArtworkImage(candidate.imageUrl)).toBe(true);
    expect(isAllowedArtworkImage('https://example.com/x.jpg')).toBe(false);
    expect(isAllowedArtworkImage('http://images.metmuseum.org/x.jpg')).toBe(false);
    expect(stylesForDirection('signal')).toContain('modern');
    expect(stylesForDirection('editorial')).toContain('impressionist');
  });
});

describe('live museum search', () => {
  const responses: Record<string, unknown> = {
    'collectionapi.metmuseum.org/public/collection/v1/search': { objectIDs: [1, 2] },
    'collectionapi.metmuseum.org/public/collection/v1/objects/1': {
      objectID: 1,
      isPublicDomain: true,
      primaryImage: 'https://images.metmuseum.org/CRDImages/ep/original/a.jpg',
      primaryImageSmall: 'https://images.metmuseum.org/CRDImages/ep/web-large/a.jpg',
      title: 'Harbor at Dusk',
      artistDisplayName: 'A. Painter',
      objectDate: '1880',
      objectURL: 'https://www.metmuseum.org/art/collection/search/1',
    },
    'collectionapi.metmuseum.org/public/collection/v1/objects/2': {
      objectID: 2,
      isPublicDomain: false,
      primaryImage: 'x',
    },
    'openaccess-api.clevelandart.org/api/artworks/': {
      data: [
        {
          id: 9,
          title: 'Harbor',
          creators: [{ description: 'B. Painter (American, 1850-1920)' }],
          creation_date: '1901',
          url: 'https://clevelandart.org/art/1901.9',
          images: {
            web: { url: 'https://openaccess-cdn.clevelandart.org/1901.9/1901.9_web.jpg' },
            print: { url: 'https://openaccess-cdn.clevelandart.org/1901.9/1901.9_print.jpg' },
          },
        },
      ],
    },
    'api.artic.edu/api/v1/artworks/search': {
      data: [
        {
          id: 5,
          title: 'Harbor Scene',
          artist_display: 'C. Painter',
          date_display: '1890',
          image_id: 'img5',
        },
      ],
    },
    'api.smk.dk/api/v1/art/search/': {
      items: [
        {
          object_number: 'KMS1',
          titles: [{ title: 'Havn' }],
          production: [{ creator: 'D. Maler' }],
          production_date: [{ period: '1870' }],
          image_native: 'https://iip.smk.dk/iiif/jp2/kms1/full/full/0/native.jpg',
          image_thumbnail: 'https://iip.smk.dk/iiif/jp2/kms1/full/!400,/0/native.jpg',
        },
      ],
    },
  };
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(responses).find((prefix) => url.includes(prefix));
    if (!key) return new Response('nope', { status: 500 });
    return new Response(JSON.stringify(responses[key]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  test('normalizes every provider, drops non-public pieces, and survives a failing provider', async () => {
    const results = await searchArtLive('harbor', { fetch: fakeFetch });
    expect(results.map((c) => c.provider).sort()).toEqual(['aic', 'cleveland', 'met', 'smk']);
    const met = results.find((c) => c.provider === 'met')!;
    expect(met.credit).toBe('Harbor at Dusk, A. Painter, 1880');
    expect(results.find((c) => c.provider === 'cleveland')!.imageUrl).toContain('_print');
    expect(results.find((c) => c.provider === 'aic')!.imageUrl).toContain('/iiif/2/img5/full/1686,/');
    expect(results.every((c) => isAllowedArtworkImage(c.imageUrl))).toBe(true);
    const failing = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    expect(await searchArtLive('harbor', { fetch: failing })).toEqual([]);
  });
  test('searchArtworks merges pool first and live second without duplicates', async () => {
    const merged = await searchArtworks({ text: 'harbor', live: true, count: 30 }, { fetch: fakeFetch });
    const pool = searchArtPool({ text: 'harbor', count: 30 });
    expect(merged.slice(0, pool.length).map((c) => c.key)).toEqual(pool.map((c) => c.key));
    expect(merged.length).toBeGreaterThan(pool.length);
    expect(new Set(merged.map((c) => c.sourceUrl)).size).toBe(merged.length);
    expect(await searchArtworks({ text: 'harbor', live: false }, { fetch: fakeFetch })).toEqual(
      searchArtPool({ text: 'harbor', count: 12 }),
    );
  });
});

describe('artwork import', () => {
  afterEach(() => __setDeckArtDepsForTest());
  const jpeg = readFileSync('public/art/fallback-1.jpg');
  test('bounds, re-encodes and reads a palette from a real image', async () => {
    const prepared = await prepareArtworkImage(new Uint8Array(jpeg));
    expect(prepared.width).toBe(600);
    expect(prepared.height).toBe(449);
    expect(prepared.palette.length).toBeGreaterThan(2);
    expect(prepared.palette[0]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(prepared.bytes[0]).toBe(0xff);
  });
  test('fetches only museum hosts and stores the asset with attribution', async () => {
    const stored: Array<{ userId: string; bytes: number; attribution?: unknown }> = [];
    __setDeckArtDepsForTest({
      fetch: (async () => new Response(jpeg, { status: 200 })) as never,
      store: async (userId, bytes, attribution) => {
        stored.push({ userId, bytes: bytes.length, attribution });
        return {
          assetId: 'a1',
          src: 'https://precise-skunk-847.convex.cloud/x',
          width: 600,
          height: 449,
          aspect: 1.336,
          mime: 'image/jpeg',
          size: bytes.length,
          attribution,
        };
      },
    });
    const candidate = candidateFromPiece(ART_POOL.find((piece) => piece.source === 'cleveland')!);
    const imported = await importArtwork('user-1', candidate);
    expect(imported.assetId).toBe('a1');
    expect(imported.attribution.credit).toBe(candidate.credit);
    expect(imported.palette.length).toBeGreaterThan(0);
    expect(stored[0]).toMatchObject({ userId: 'user-1' });
    await expect(
      importArtwork('user-1', { ...candidate, imageUrl: 'https://example.com/a.jpg' }),
    ).rejects.toThrow('supported museum');
    __setDeckArtDepsForTest({ fetch: (async () => new Response('', { status: 404 })) as never });
    await expect(importArtwork('user-1', candidate)).rejects.toThrow('404');
  });
});

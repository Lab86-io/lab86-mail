import { describe, expect, test } from 'bun:test';
import { ART_STYLES } from '../lib/mail/art-style';
import { dailyArtCandidates, getDailyArt, highResolutionArtUrl } from '../lib/mail/daily-art';
import { ART_POOL } from '../lib/mail/daily-art-pool';

describe('daily art image URLs', () => {
  test('uses higher-resolution public museum derivatives when available', () => {
    expect(highResolutionArtUrl('https://images.metmuseum.org/CRDImages/dp/web-large/DP815958.jpg')).toBe(
      'https://images.metmuseum.org/CRDImages/dp/original/DP815958.jpg',
    );
    expect(highResolutionArtUrl('https://openaccess-cdn.clevelandart.org/1972.47/1972.47_web.jpg')).toBe(
      'https://openaccess-cdn.clevelandart.org/1972.47/1972.47_print.jpg',
    );
  });

  test('leaves already-sized IIIF URLs alone', () => {
    expect(
      highResolutionArtUrl(
        'https://www.artic.edu/iiif/2/1e452e34-3a2b-0dca-35c3-c7236c612985/full/1686,/0/default.jpg',
      ),
    ).toContain('/full/1686,/0/default.jpg');
  });

  test('does not use Art Institute IIIF URLs as primary art', () => {
    const art = getDailyArt(Date.parse('2026-06-30T05:49:00.000Z'));
    expect(art.imageUrl).not.toContain('artic.edu/iiif');
    expect(art.fallbacks.some((url) => url.includes('/art/fallback-1.jpg'))).toBe(true);
  });

  test('ships a deeper catalog with image palettes, provenance and four working sources', () => {
    expect(ART_POOL.length).toBeGreaterThanOrEqual(300);
    expect(new Set(ART_POOL.map((piece) => piece.source)).size).toBe(4);
    expect(new Set(ART_POOL.map((piece) => piece.imageUrl)).size).toBe(ART_POOL.length);
    for (const piece of ART_POOL) {
      expect(piece.palette.length).toBeGreaterThan(0);
      expect(piece.palette.length).toBeLessThanOrEqual(6);
      expect(piece.palette.every((color) => /^#[a-f0-9]{6}$/.test(color))).toBe(true);
      expect(piece.sourceUrl).toMatch(/^https:\/\//);
      expect(['CC0', 'Public domain']).toContain(piece.license);
      expect(ART_STYLES).toContain(piece.style);
    }
  });

  test('keeps a day stable, rotates all museums and carries matching fallback metadata', () => {
    const counts = new Map<string, number>();
    for (let day = 0; day < 366; day += 1) {
      const at = Date.UTC(2026, 0, 1 + day, 1);
      const art = getDailyArt(at);
      expect(getDailyArt(at + 20 * 3600_000)).toEqual(art);
      counts.set(art.source, (counts.get(art.source) ?? 0) + 1);
      const candidates = dailyArtCandidates(art);
      expect(candidates.map((piece) => piece.imageUrl)).toEqual([art.imageUrl, ...art.fallbacks]);
      const museums = candidates.filter((piece) => piece.source);
      expect(new Set(museums.map((piece) => piece.source)).size).toBe(museums.length);
      for (const candidate of museums) {
        const original = ART_POOL.find(
          (piece) => highResolutionArtUrl(piece.imageUrl) === candidate.imageUrl,
        )!;
        expect(candidate.title).toBe(original.title);
        expect(candidate.palette).toEqual(original.palette);
        expect(candidate.style).toBe(original.style);
      }
      expect(candidates.at(-1)?.credit).toBe('');
      expect(candidates.at(-1)?.palette?.length).toBeGreaterThan(0);
    }
    expect(counts.size).toBe(4);
    for (const count of counts.values()) expect(count).toBeGreaterThan(50);
  });

  test('returned palettes cannot mutate the shared catalog', () => {
    const at = Date.UTC(2026, 8, 11);
    const first = getDailyArt(at);
    const expected = first.palette?.[0];
    first.palette![0] = '#000000';
    expect(getDailyArt(at).palette?.[0]).toBe(expected);
  });
});

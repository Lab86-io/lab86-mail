import { describe, expect, test } from 'bun:test';
import { ART_STYLES, artStyleFor, yearFromDate } from '../lib/mail/art-style';

describe('art style classification', () => {
  test('period bands', () => {
    expect(artStyleFor({ year: 1510, region: 'Italy' })).toBe('renaissance');
    expect(artStyleFor({ year: 1650, region: 'Dutch' })).toBe('dutch-golden-age');
    expect(artStyleFor({ year: 1650, region: 'Flanders' })).toBe('dutch-golden-age');
    expect(artStyleFor({ year: 1650, region: 'Italian' })).toBe('baroque');
    expect(artStyleFor({ year: 1750, region: 'French' })).toBe('rococo');
    expect(artStyleFor({ year: 1800, region: 'French' })).toBe('neoclassical');
    expect(artStyleFor({ year: 1845, region: 'German' })).toBe('romantic');
    expect(artStyleFor({ year: 1860, region: 'American' })).toBe('american');
    expect(artStyleFor({ year: 1885, region: 'French' })).toBe('impressionist');
    expect(artStyleFor({ year: 1890, region: 'American' })).toBe('american');
    expect(artStyleFor({ year: 1925, region: 'French' })).toBe('modern');
  });

  test('east asian works win over the date, and unknown dates read as romantic', () => {
    expect(artStyleFor({ year: 1830, region: 'Japan' })).toBe('east-asian');
    expect(artStyleFor({ year: 1700, medium: 'Handscroll; ink on silk', region: 'China' })).toBe(
      'east-asian',
    );
    expect(artStyleFor({ year: null, region: '' })).toBe('romantic');
  });

  test('every style is listed once', () => {
    expect(new Set(ART_STYLES).size).toBe(ART_STYLES.length);
  });

  test('explicit movements take precedence over dates, and early work gets Gothic frames', () => {
    expect(artStyleFor({ year: 1895, movement: 'Art Deco' })).toBe('art-deco');
    expect(artStyleFor({ year: 1885, movement: 'Abstract expressionism' })).toBe('modern');
    expect(artStyleFor({ year: 1800, movement: 'Gothic revival' })).toBe('gothic');
    expect(artStyleFor({ year: 1350 })).toBe('gothic');
    expect(artStyleFor({ year: 1650, region: 'Hollandsk' })).toBe('dutch-golden-age');
  });

  test('year parsing', () => {
    expect(yearFromDate('c. 1560')).toBe(1560);
    expect(yearFromDate('1635-1655')).toBe(1635);
    expect(yearFromDate('late 19th century')).toBeNull();
    expect(yearFromDate(undefined)).toBeNull();
  });
});

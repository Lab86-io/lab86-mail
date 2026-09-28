import { describe, expect, test } from 'bun:test';
import { contentHash, orderedContent, sameFields, stableContent, stableHash } from '../lib/sync/content-hash';

describe('sync content hash', () => {
  test('key order and undefined keys do not change the content', () => {
    expect(stableContent({ b: 1, a: [{ d: 2, c: 3 }], x: undefined })).toBe(
      stableContent({ a: [{ c: 3, d: 2 }], b: 1 }),
    );
    expect(contentHash({ b: 1, a: 'x' })).toBe(contentHash({ a: 'x', b: 1 }));
    expect(orderedContent({ z: 1, a: { y: 2, b: 3 } })).toEqual({ a: { b: 3, y: 2 }, z: 1 });
  });

  test('a changed value, array order, or type changes the hash', () => {
    const base = contentHash({ title: 'Plan', tags: ['a', 'b'], count: 1 });
    expect(contentHash({ title: 'Plan!', tags: ['a', 'b'], count: 1 })).not.toBe(base);
    expect(contentHash({ title: 'Plan', tags: ['b', 'a'], count: 1 })).not.toBe(base);
    expect(contentHash({ title: 'Plan', tags: ['a', 'b'], count: '1' })).not.toBe(base);
  });

  test('stableContent is a string for an undefined value', () => {
    expect(stableContent(undefined)).toBe('undefined');
    expect(stableContent(null)).toBe('null');
  });

  test('stableHash is stable and short', () => {
    expect(stableHash('hello')).toBe(stableHash('hello'));
    expect(stableHash('hello')).not.toBe(stableHash('hellp'));
    expect(stableHash('')).toMatch(/^[0-9a-z]+$/);
  });

  test('sameFields compares only the named keys and treats missing as undefined', () => {
    const stored = { title: 'A', tags: ['x'], updatedAt: 1, description: undefined };
    expect(
      sameFields(stored, { title: 'A', tags: ['x'], updatedAt: 99 }, ['title', 'tags', 'description']),
    ).toBe(true);
    expect(sameFields(stored, { title: 'B', tags: ['x'] }, ['title', 'tags'])).toBe(false);
    expect(sameFields({ title: 'A', description: 'old' }, { title: 'A' }, ['title', 'description'])).toBe(
      false,
    );
    expect(sameFields(null, { title: 'A' }, ['title'])).toBe(false);
  });
});

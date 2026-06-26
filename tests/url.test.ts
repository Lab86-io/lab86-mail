import { describe, expect, test } from 'bun:test';
import { normalizeUrl } from '../lib/shared/url';

describe('normalizeUrl', () => {
  test('passes through absolute http(s) URLs', () => {
    expect(normalizeUrl('https://example.test/path?q=1')).toBe('https://example.test/path?q=1');
    expect(normalizeUrl('http://example.test/')).toBe('http://example.test/');
  });
  test('passes through mailto and tel schemes', () => {
    expect(normalizeUrl('mailto:hello@example.test')).toBe('mailto:hello@example.test');
    expect(normalizeUrl('tel:+15551234567')).toBe('tel:+15551234567');
  });
  test('assumes https for bare hosts', () => {
    expect(normalizeUrl('example.test/docs')).toBe('https://example.test/docs');
    expect(normalizeUrl('www.example.test')).toBe('https://www.example.test/');
  });
  test('rejects empty or non-host inputs', () => {
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
    expect(normalizeUrl('notes')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
  test('rejects malformed absolute URLs', () => {
    expect(normalizeUrl('https://')).toBeNull();
  });
});

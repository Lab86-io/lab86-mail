import { describe, expect, test } from 'bun:test';
import { sanitizeInternalPath } from '../lib/security/redirect';

describe('sanitizeInternalPath', () => {
  test('allows same-origin relative paths', () => {
    expect(sanitizeInternalPath('/settings/mail')).toBe('/settings/mail');
    expect(sanitizeInternalPath('/')).toBe('/');
  });
  test('blocks open redirects', () => {
    expect(sanitizeInternalPath('https://evil.test')).toBe('/');
    expect(sanitizeInternalPath('//evil.test/path')).toBe('/');
    expect(sanitizeInternalPath('/\\evil')).toBe('/');
    expect(sanitizeInternalPath('/foo:bar')).toBe('/foo:bar');
    expect(sanitizeInternalPath('foo:bar')).toBe('/');
  });
  test('defaults empty values to root', () => {
    expect(sanitizeInternalPath(null)).toBe('/');
    expect(sanitizeInternalPath('')).toBe('/');
  });
});

import { describe, expect, test } from 'bun:test';
import { buildAuthorizationHeader } from '../lib/mcp/auth';

describe('buildAuthorizationHeader', () => {
  test('rejects empty credentials', () => {
    expect(() => buildAuthorizationHeader('   ')).toThrow(/access token is empty/);
    expect(() => buildAuthorizationHeader('Bearer')).toThrow(/access token is empty/);
  });
  test('normalizes bearer and token prefixes', () => {
    expect(buildAuthorizationHeader('token ghp_123')).toBe('Bearer ghp_123');
    expect(buildAuthorizationHeader('Bearer\nabc 123')).toBe('Bearer abc123');
  });
  test('supports explicit Basic headers in basic-or-bearer mode', () => {
    expect(buildAuthorizationHeader('Basic abc123', 'basic-or-bearer')).toBe('Basic abc123');
  });
});

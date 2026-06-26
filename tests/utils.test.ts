import { describe, expect, test } from 'bun:test';
import { cn } from '../lib/utils';

describe('cn', () => {
  test('merges class names and resolves Tailwind conflicts', () => {
    expect(cn('px-2 py-1', 'px-4', false && 'hidden', undefined)).toBe('py-1 px-4');
    expect(cn('text-sm', 'font-bold')).toBe('text-sm font-bold');
  });
});

import { describe, expect, test } from 'bun:test';
import { checkinCallerArgs } from '@/lib/albatross/checkin';

describe('Albatross check-in server caller', () => {
  test('passes the authenticated Clerk user through to internal-secret Convex calls', () => {
    expect(checkinCallerArgs(' user_123 ')).toEqual({ userId: 'user_123' });
    expect(() => checkinCallerArgs(' ')).toThrow('userId is required');
  });
});

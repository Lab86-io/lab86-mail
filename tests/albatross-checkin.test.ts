import { describe, expect, test } from 'bun:test';
import { checkinCallerArgs, tomorrowWorkPlanStatus } from '@/lib/albatross/checkin';

describe('Albatross check-in server caller', () => {
  test('passes the authenticated Clerk user through to internal-secret Convex calls', () => {
    expect(checkinCallerArgs(' user_123 ')).toEqual({ userId: 'user_123' });
    expect(() => checkinCallerArgs(' ')).toThrow('userId is required');
  });

  test('retries an interrupted tomorrow plan but never duplicates applied work or its question', () => {
    expect(tomorrowWorkPlanStatus(null)).toBe('advance');
    expect(tomorrowWorkPlanStatus({ plan: { status: 'ready' }, questions: [] })).toBe('advance');
    expect(tomorrowWorkPlanStatus({ plan: { status: 'applied' }, questions: [] })).toBe('already_applied');
    expect(
      tomorrowWorkPlanStatus({
        plan: { status: 'needs_answers' },
        questions: [{ status: 'pending' }],
      }),
    ).toBe('needs_input');
  });
});

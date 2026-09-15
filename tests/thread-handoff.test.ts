import { describe, expect, test } from 'bun:test';
import { recommendationFor } from '../lib/mail/thread-handoff';

describe('follow-up recommendations', () => {
  test('replaces a generic action with the person, subject, and unresolved question', () => {
    expect(
      recommendationFor({
        candidate: 'Follow up',
        lane: 'follow_up_owed',
        people: ['Maya <maya@example.test>'],
        subject: 'Re: Launch date',
        openLoops: ['Follow up', 'the July 31 launch date'],
      }),
    ).toBe('Follow up with Maya about “Launch date”; ask about the July 31 launch date.');
  });

  test('handles missing context and preserves a specific authored recommendation', () => {
    expect(recommendationFor({ lane: 'follow_up_owed', subject: '(no subject)' })).toBe('Follow up.');
    expect(
      recommendationFor({ lane: 'follow_up_owed', candidate: 'Ask Maya to confirm the July 31 date.' }),
    ).toBe('Ask Maya to confirm the July 31 date.');
  });
});

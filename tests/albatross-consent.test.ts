import { describe, expect, test } from 'bun:test';
import { approvalKind, statusForApplication } from '../lib/tools/albatross';

// Consent policy. Which kind of approval a step needs is not a formatting
// detail — it decides whether Albatross may touch somebody else's world
// without asking. These are the rules that keep "it acted on my behalf" from
// becoming "it acted without me".

describe('approvalKind', () => {
  test('sending mail asks for send consent specifically', () => {
    expect(approvalKind({ kind: 'email_send' } as never)).toBe('email_send');
  });

  test('replying to an invitation is its own consent', () => {
    expect(approvalKind({ kind: 'calendar_rsvp' } as never)).toBe('calendar_rsvp');
  });

  test('putting something on a calendar asks before it invites anybody', () => {
    expect(approvalKind({ kind: 'calendar_event' } as never)).toBe('calendar_invite');
  });

  test('anything unrecognised falls back to the broadest consent, not the narrowest', () => {
    // Failing open here would let an unknown future step type slip through
    // with a weaker approval than it deserves.
    expect(approvalKind({ kind: 'some_future_action' } as never)).toBe('external_action');
    expect(approvalKind({ kind: 'document' } as never)).toBe('external_action');
  });
});

describe('statusForApplication', () => {
  test('nothing executed yet is queued, not applied', () => {
    expect(statusForApplication({ operations: [], approvals: [], unresolved: [] })).toBe('queued');
    expect(statusForApplication({ operations: [], approvals: [{}], unresolved: [] })).toBe('queued');
  });

  test('everything executed with nothing pending is applied', () => {
    expect(statusForApplication({ operations: [{}], approvals: [], unresolved: [] })).toBe('applied');
  });

  test('some done and some waiting says so, rather than claiming the whole plan', () => {
    expect(statusForApplication({ operations: [{}], approvals: [{}], unresolved: [] })).toBe(
      'partially_applied',
    );
    expect(statusForApplication({ operations: [{}], approvals: [], unresolved: [{}] })).toBe(
      'partially_applied',
    );
  });

  test('a partly applied plan is never reported as applied', () => {
    const partial = statusForApplication({ operations: [{}, {}], approvals: [{}], unresolved: [{}] });
    expect(partial).not.toBe('applied');
    expect(partial).toBe('partially_applied');
  });
});

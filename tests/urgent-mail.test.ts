import { describe, expect, test } from 'bun:test';
import { assessUrgency, isBulkMail, parseUrgencyConfirmation } from '../lib/mail/urgency';
import { buildAPNsPayload } from '../lib/notifications/apns';
import { nativePushDisabledReason } from '../lib/notifications/mobile-preferences';

const NOW = Date.UTC(2026, 6, 29, 12, 0, 0);

function message(overrides: Record<string, unknown> = {}) {
  return {
    subject: 'Quick question',
    from: 'Ari <ari@example.com>',
    receivedAt: NOW,
    snippet: '',
    textBody: 'Let me know when you get a chance.',
    ...overrides,
  } as any;
}

describe('assessUrgency', () => {
  test('promotes a message carrying a one-time code without model confirmation', () => {
    const verdict = assessUrgency(message(), { hasOneTimeCode: true, now: NOW });
    expect(verdict.urgent).toBe(true);
    expect(verdict.kind).toBe('code');
    expect(verdict.needsConfirmation).toBe(false);
  });

  test('promotes a security alert without model confirmation', () => {
    const verdict = assessUrgency(
      message({ subject: 'Security alert', textBody: 'New sign-in from a device in Berlin.' }),
      { now: NOW },
    );
    expect(verdict.urgent).toBe(true);
    expect(verdict.kind).toBe('security');
    expect(verdict.needsConfirmation).toBe(false);
  });

  test('requires confirmation for urgency that is only language', () => {
    const verdict = assessUrgency(
      message({ subject: 'URGENT: need your approval', textBody: 'Action required today.' }),
      { now: NOW },
    );
    expect(verdict.urgent).toBe(true);
    expect(verdict.needsConfirmation).toBe(true);
  });

  test('leaves ordinary mail alone', () => {
    expect(assessUrgency(message(), { now: NOW }).urgent).toBe(false);
  });

  test('promotes a code even when the mail looks like bulk', () => {
    // Services routinely send verification codes through the same ESP as their
    // marketing, so the mail carries List-Unsubscribe and an unsubscribe
    // footer. Letting the bulk gate win here silently kills the whole feature.
    const verdict = assessUrgency(
      message({
        subject: 'Your verification code',
        textBody: 'Your code is 284917. Unsubscribe at any time.',
        headers: [{ name: 'List-Unsubscribe', value: '<mailto:x@y.z>' }],
      }),
      { hasOneTimeCode: true, now: NOW },
    );
    expect(verdict.urgent).toBe(true);
    expect(verdict.kind).toBe('code');
  });

  test('still drops a code-bearing message that is stale', () => {
    const verdict = assessUrgency(message({ receivedAt: NOW - 24 * 3_600_000 }), {
      hasOneTimeCode: true,
      now: NOW,
    });
    expect(verdict.urgent).toBe(false);
  });

  test('never promotes bulk mail, however loud it is', () => {
    const verdict = assessUrgency(
      message({
        subject: 'URGENT: last chance today',
        textBody: 'Shop now. Unsubscribe at any time.',
      }),
      { now: NOW },
    );
    expect(verdict.urgent).toBe(false);
  });

  test('never promotes stale mail, so a redelivered backlog stays quiet', () => {
    const verdict = assessUrgency(
      message({
        subject: 'Security alert',
        textBody: 'New sign-in from a device in Berlin.',
        receivedAt: NOW - 24 * 3_600_000,
      }),
      { now: NOW },
    );
    expect(verdict.urgent).toBe(false);
  });
});

describe('isBulkMail', () => {
  test('trusts List-Unsubscribe', () => {
    expect(isBulkMail(message({ headers: [{ name: 'List-Unsubscribe', value: '<mailto:x@y.z>' }] }))).toBe(
      true,
    );
  });

  test('treats Precedence: bulk as bulk but leaves other values alone', () => {
    expect(isBulkMail(message({ headers: { Precedence: 'bulk' } }))).toBe(true);
    expect(isBulkMail(message({ headers: { Precedence: 'urgent' } }))).toBe(false);
  });

  test('trusts provider categories', () => {
    expect(isBulkMail(message({ labels: ['CATEGORY_PROMOTIONS'] }))).toBe(true);
    expect(isBulkMail(message({ labels: ['INBOX'] }))).toBe(false);
  });
});

describe('parseUrgencyConfirmation', () => {
  test('accepts a confident yes', () => {
    expect(
      parseUrgencyConfirmation('{"urgent":true,"confidence":0.9,"reason":"Contract needs signing"}'),
    ).toEqual({ urgent: true, reason: 'Contract needs signing' });
  });

  test('accepts a fenced reply', () => {
    expect(
      parseUrgencyConfirmation('```json\n{"urgent":true,"confidence":0.8,"reason":"Needs a decision"}\n```')
        .urgent,
    ).toBe(true);
  });

  test('refuses a low-confidence yes', () => {
    expect(parseUrgencyConfirmation('{"urgent":true,"confidence":0.4,"reason":"Maybe"}').urgent).toBe(false);
  });

  test('refuses a yes with no reason', () => {
    expect(parseUrgencyConfirmation('{"urgent":true,"confidence":0.9}').urgent).toBe(false);
  });

  test('refuses anything unparseable', () => {
    expect(parseUrgencyConfirmation('probably urgent!').urgent).toBe(false);
    expect(parseUrgencyConfirmation('{broken').urgent).toBe(false);
  });
});

describe('buildAPNsPayload for urgent mail', () => {
  const envelope = {
    id: 'notice-1',
    userId: 'user-1',
    type: 'urgent_mail',
    title: 'Ari',
    body: 'Contract — needs a decision today',
    deepLink: '/mail/thread?account=acc-1&thread=th-1&message=msg-1&urgent=1',
  };

  test('raises the interruption level and uses the urgent category', () => {
    const payload = buildAPNsPayload(envelope);
    expect(payload.aps['interruption-level']).toBe('time-sensitive');
    expect(payload.aps.category).toBe('LAB86_URGENT');
    expect(payload.aps['relevance-score']).toBe(1);
    expect(payload.threadId).toBe('th-1');
  });

  test('leaves ordinary mail at the default level', () => {
    const payload = buildAPNsPayload({ ...envelope, type: 'mail_message' });
    expect(payload.aps['interruption-level']).toBeUndefined();
    expect(payload.aps.category).toBe('LAB86_MAIL');
    expect(payload.aps['relevance-score']).toBe(0.25);
  });

  test('flags a code push so the woken app refreshes its codes', () => {
    expect(buildAPNsPayload({ ...envelope, codeAvailable: true }).codeAvailable).toBe(true);
    expect(buildAPNsPayload(envelope).codeAvailable).toBeUndefined();
  });
});

describe('nativePushDisabledReason', () => {
  test('gates urgent mail on its own switch', () => {
    expect(nativePushDisabledReason('urgent_mail', { urgentMailPushEnabled: false })).toBe(
      'urgent_mail_disabled',
    );
  });

  test('does not silence urgent mail when routine new-mail push is muted', () => {
    expect(nativePushDisabledReason('urgent_mail', { newMailPushEnabled: false })).toBeNull();
  });

  test('still honours the master switch', () => {
    expect(nativePushDisabledReason('urgent_mail', { nativePushEnabled: false })).toBe(
      'native_push_disabled',
    );
  });
});

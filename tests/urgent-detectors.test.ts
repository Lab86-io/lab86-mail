import { describe, expect, test } from 'bun:test';
import {
  detectUrgentMailAndCodes,
  scanIngestedMail,
  type UrgentScanMessage,
} from '../lib/mail/urgent-detectors';

const ROW = { userId: 'user-1', accountId: 'acc-1', grantId: 'g', status: 'connected' } as any;

function message(overrides: Partial<UrgentScanMessage> = {}): UrgentScanMessage {
  return {
    providerMessageId: 'msg-1',
    providerThreadId: 'th-1',
    subject: 'Hello',
    from: 'Ari <ari@example.com>',
    receivedAt: Date.now(),
    snippet: '',
    textBody: 'Just checking in when you get a chance.',
    ...overrides,
  };
}

const CODE_MAIL = {
  subject: 'Your verification code',
  from: 'Google <no-reply@accounts.google.com>',
  textBody: 'Your verification code is 284917. It expires in 10 minutes.',
};

interface HarnessOptions {
  preference?: Record<string, boolean> | null;
  recordCreated?: boolean;
  queueCreated?: boolean;
  confirm?: (userId: string, message: UrgentScanMessage) => Promise<string | null>;
  dispatchThrows?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const calls: Array<{ name: string; args: any }> = [];
  const dispatches: Array<{ notificationId: string; options: any }> = [];

  const query = (async () => (options.preference === undefined ? {} : options.preference)) as any;

  const mutate = (async (_fn: any, args: any) => {
    // Only recordCode carries a `code`; only the queue call carries a `reason`.
    if (args?.code !== undefined) {
      calls.push({ name: 'recordCode', args });
      return { created: options.recordCreated ?? true };
    }
    if (args?.reason === undefined && args?.snippet !== undefined) {
      calls.push({ name: 'newMail', args });
      return { notificationId: 'notif-mail', created: options.queueCreated ?? true };
    }
    calls.push({ name: 'queueUrgent', args });
    return { notificationId: 'notif-1', created: options.queueCreated ?? true };
  }) as any;

  const dispatch = (async (_userId: string, notificationId: string, _deps: any, opts: any) => {
    if (options.dispatchThrows) throw new Error('APNs unavailable');
    dispatches.push({ notificationId, options: opts });
    return { sent: 1, failed: 0 };
  }) as any;

  const confirm = (options.confirm ?? (async () => 'Needs a decision today')) as any;

  return { deps: { query, mutate, dispatch, confirm }, calls, dispatches };
}

describe('detectUrgentMailAndCodes preferences', () => {
  test('does no work when every feature is off', async () => {
    const { deps, calls } = harness({
      preference: {
        nativePushEnabled: true,
        newMailPushEnabled: false,
        urgentMailPushEnabled: false,
        oneTimeCodeAutofillEnabled: false,
      },
    });
    const result = await detectUrgentMailAndCodes(ROW, [message(CODE_MAIL)], deps);
    expect(result).toEqual({ codes: 0, urgent: 0, newMail: 0 });
    expect(calls).toHaveLength(0);
  });

  test('records codes but sends no urgent alert when urgent push is off', async () => {
    const { deps, calls, dispatches } = harness({
      preference: {
        newMailPushEnabled: false,
        urgentMailPushEnabled: false,
        oneTimeCodeAutofillEnabled: true,
      },
    });
    const result = await detectUrgentMailAndCodes(ROW, [message(CODE_MAIL)], deps);
    expect(result.codes).toBe(1);
    expect(result.urgent).toBe(0);
    expect(calls.map((c) => c.name)).toEqual(['recordCode']);
    expect(dispatches).toHaveLength(0);
  });

  test('pushes but records nothing when only AutoFill is off', async () => {
    const { deps, calls } = harness({
      preference: { newMailPushEnabled: false, oneTimeCodeAutofillEnabled: false },
    });
    const result = await detectUrgentMailAndCodes(
      ROW,
      [message({ subject: 'Security alert', textBody: 'New sign-in from a device in Berlin.' })],
      deps,
    );
    expect(result.codes).toBe(0);
    expect(result.urgent).toBe(1);
    expect(calls.map((c) => c.name)).toEqual(['queueUrgent']);
  });

  test('treats an unreadable preference row as everything enabled', async () => {
    const { deps } = harness({ preference: null });
    const result = await detectUrgentMailAndCodes(ROW, [message(CODE_MAIL)], deps);
    expect(result.codes).toBe(1);
  });

  test('short-circuits on an empty batch', async () => {
    const { deps, calls } = harness();
    expect(await detectUrgentMailAndCodes(ROW, [], deps)).toEqual({ codes: 0, urgent: 0, newMail: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe('detectUrgentMailAndCodes code handling', () => {
  test('records a code and flags the push so the app refreshes AutoFill', async () => {
    const { deps, calls, dispatches } = harness();
    const result = await detectUrgentMailAndCodes(ROW, [message(CODE_MAIL)], deps);

    expect(result).toEqual({ codes: 1, urgent: 1, newMail: 0 });
    const recorded = calls.find((c) => c.name === 'recordCode');
    expect(recorded?.args.code).toBe('284917');
    expect(recorded?.args.serviceIdentifiers).toContain('google.com');
    expect(dispatches[0].options).toEqual({ codeAvailable: true });
  });

  test('a redelivered webhook does not alert twice', async () => {
    // recordCode reporting created=false is how a duplicate arrives.
    const { deps, calls, dispatches } = harness({ recordCreated: false });
    const result = await detectUrgentMailAndCodes(ROW, [message(CODE_MAIL)], deps);

    expect(result).toEqual({ codes: 0, urgent: 0, newMail: 0 });
    expect(calls.map((c) => c.name)).toEqual(['recordCode']);
    expect(dispatches).toHaveLength(0);
  });

  test('a code never needs model confirmation', async () => {
    let confirmed = 0;
    const { deps } = harness({
      confirm: async () => {
        confirmed += 1;
        return 'should not be called';
      },
    });
    await detectUrgentMailAndCodes(ROW, [message(CODE_MAIL)], deps);
    expect(confirmed).toBe(0);
  });
});

describe('detectUrgentMailAndCodes urgency confirmation', () => {
  const LOUD = { subject: 'URGENT: need your approval', textBody: 'Action required today.' };

  test('promotes only when the model agrees, and uses its reason', async () => {
    const { deps, calls } = harness({ confirm: async () => 'Contract needs signing' });
    const result = await detectUrgentMailAndCodes(ROW, [message(LOUD)], deps);
    expect(result.urgent).toBe(1);
    expect(calls.find((c) => c.name === 'queueUrgent')?.args.reason).toBe('Contract needs signing');
  });

  test('drops the alert when the model declines', async () => {
    const { deps, calls } = harness({ confirm: async () => null });
    const result = await detectUrgentMailAndCodes(ROW, [message(LOUD)], deps);
    expect(result.urgent).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('a failing confirmation is not an alert', async () => {
    const { deps } = harness({
      confirm: async () => {
        throw new Error('model timed out');
      },
    });
    expect((await detectUrgentMailAndCodes(ROW, [message(LOUD)], deps)).urgent).toBe(0);
  });

  test('caps model calls per batch so a burst cannot fan out', async () => {
    let confirmations = 0;
    const { deps } = harness({
      confirm: async () => {
        confirmations += 1;
        return 'Needs a decision';
      },
    });
    const batch = Array.from({ length: 6 }, (_, index) =>
      message({ ...LOUD, providerMessageId: `msg-${index}`, providerThreadId: `th-${index}` }),
    );
    const result = await detectUrgentMailAndCodes(ROW, batch, deps);

    expect(confirmations).toBe(3);
    expect(result.urgent).toBe(3);
  });
});

describe('detectUrgentMailAndCodes resilience', () => {
  test('a dedupe hit on the notification does not count as an alert', async () => {
    const { deps, dispatches } = harness({ queueCreated: false });
    const result = await detectUrgentMailAndCodes(
      ROW,
      [message({ subject: 'Security alert', textBody: 'Unusual sign-in detected.' })],
      deps,
    );
    expect(result.urgent).toBe(0);
    expect(dispatches).toHaveLength(0);
  });

  test('a push failure still counts the alert and never throws', async () => {
    // Mail sync awaits this; a dead APNs must not fail the ingest.
    const { deps } = harness({ dispatchThrows: true });
    const result = await detectUrgentMailAndCodes(
      ROW,
      [message({ subject: 'Security alert', textBody: 'Unusual sign-in detected.' })],
      deps,
    );
    expect(result.urgent).toBe(1);
  });

  test('one bad message does not abandon the rest of the batch', async () => {
    const { deps } = harness();
    const exploding = message({ providerMessageId: 'boom' });
    Object.defineProperty(exploding, 'subject', {
      get() {
        throw new Error('corrupt row');
      },
    });
    const result = await detectUrgentMailAndCodes(
      ROW,
      [exploding, message({ ...CODE_MAIL, providerMessageId: 'msg-2' })],
      deps,
    );
    expect(result.codes).toBe(1);
  });

  test('ordinary mail produces a plain notification and nothing else', async () => {
    const { deps, calls } = harness();
    const result = await detectUrgentMailAndCodes(ROW, [message()], deps);
    expect(result).toEqual({ codes: 0, urgent: 0, newMail: 1 });
    expect(calls.map((c) => c.name)).toEqual(['newMail']);
  });
});

describe('scanIngestedMail', () => {
  test('swallows a total failure so mail sync still completes', async () => {
    // The ingest path awaits this. If it could throw, a broken alert would
    // abort the corpus write that the whole mailbox depends on.
    const exploding = {
      query: async () => {
        throw new Error('convex unreachable');
      },
    } as any;
    // Force the outer guard: the internal query catch is bypassed by making
    // the preference read reject in a way detect cannot absorb.
    const thrower = {
      ...exploding,
      query: () => {
        throw new Error('synchronous convex failure');
      },
    } as any;

    expect(await scanIngestedMail(ROW, [message(CODE_MAIL)], thrower)).toEqual({
      codes: 0,
      urgent: 0,
      newMail: 0,
    });
  });

  test('passes results through when nothing goes wrong', async () => {
    const { deps } = harness();
    expect(await scanIngestedMail(ROW, [message(CODE_MAIL)], deps)).toEqual({
      codes: 1,
      urgent: 1,
      newMail: 0,
    });
  });
});

describe('per-message new-mail notifications', () => {
  const ORDINARY = { subject: 'Lunch tomorrow?', textBody: 'Are you free around one?' };

  test('every ordinary arrival gets a notification', async () => {
    const { deps, calls, dispatches } = harness();
    const result = await detectUrgentMailAndCodes(ROW, [message(ORDINARY)], deps);

    expect(result.newMail).toBe(1);
    const queued = calls.find((c) => c.name === 'newMail');
    expect(queued?.args.sender).toContain('ari@example.com');
    expect(dispatches).toHaveLength(1);
    // Ordinary mail must not carry the code flag or the elevated level.
    expect(dispatches[0].options).toEqual({});
  });

  test('an urgent message sends one alert, not two', async () => {
    // A code is urgent, so it must not also produce an ordinary new-mail ping.
    const { deps, calls } = harness();
    const result = await detectUrgentMailAndCodes(ROW, [message(CODE_MAIL)], deps);

    expect(result.urgent).toBe(1);
    expect(result.newMail).toBe(0);
    expect(calls.filter((c) => c.name === 'newMail')).toHaveLength(0);
  });

  test('respects the new-mail switch independently of the urgent switch', async () => {
    const { deps, calls } = harness({
      preference: { newMailPushEnabled: false, urgentMailPushEnabled: true },
    });
    const result = await detectUrgentMailAndCodes(ROW, [message(ORDINARY)], deps);
    expect(result.newMail).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('the master switch silences ordinary mail too', async () => {
    const { deps } = harness({ preference: { nativePushEnabled: false } });
    expect((await detectUrgentMailAndCodes(ROW, [message(ORDINARY)], deps)).newMail).toBe(0);
  });

  test('never pings for the user’s own sent mail, drafts, spam or trash', async () => {
    for (const label of ['SENT', 'DRAFT', 'SPAM', 'TRASH']) {
      const { deps } = harness();
      const result = await detectUrgentMailAndCodes(ROW, [message({ ...ORDINARY, labels: [label] })], deps);
      expect(result.newMail).toBe(0);
    }
  });

  test('a redelivered backlog does not fire a burst of stale pings', async () => {
    const { deps } = harness();
    const stale = message({ ...ORDINARY, receivedAt: Date.now() - 24 * 3_600_000 });
    expect((await detectUrgentMailAndCodes(ROW, [stale], deps)).newMail).toBe(0);
  });
});

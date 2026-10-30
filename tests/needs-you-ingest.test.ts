import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { classifierById } from '../lib/classifier/catalog';
import { DEFAULT_JEV_PREFERENCES } from '../lib/jev/contract';
import { runJevSweep } from '../lib/jev/service';
import { detectUrgentMailAndCodes, type UrgentScanMessage } from '../lib/mail/urgent-detectors';
import { mailInput, responseFor } from './fixtures/jev';

// Invented people and companies only.
const JEV = classifierById('jev-1.13')!;
const ROW = { userId: 'user-1', accountId: 'acc-1', grantId: 'g', status: 'connected' } as any;
// 23:30 in New York, inside quiet hours 22-7.
const LATE = Date.parse('2026-09-27T03:30:00.000Z');

function message(overrides: Partial<UrgentScanMessage> = {}): UrgentScanMessage {
  return {
    providerMessageId: 'msg-1',
    providerThreadId: 'th-1',
    subject: 'Lunch?',
    from: 'Ari Park <ari@example.com>',
    receivedAt: LATE,
    snippet: '',
    textBody: 'Want to get lunch sometime next week?',
    ...overrides,
  };
}
const CODE_MAIL = {
  subject: 'Your verification code',
  from: 'Northwind Bank <no-reply@northwind.test>',
  textBody: 'Your verification code is 284917. It expires in 10 minutes.',
};
const URGENT_MAIL = { subject: 'Security alert', textBody: 'New sign-in from a device in Berlin.' };

function harness(
  options: {
    needsYou?: boolean;
    obligationId?: string | null;
    quiet?: boolean;
    deliverThrows?: boolean;
  } = {},
) {
  const calls: Array<{ fn: string; args: any }> = [];
  const dispatches: Array<{ notificationId: string; options: any }> = [];
  const delivered: Array<{ userId: string; ids: string[] }> = [];
  const deps: any = {
    query: async (fn: any) =>
      getFunctionName(fn).endsWith(':mailPushSettings') && options.quiet
        ? {
            mode: 'all',
            quietHours: { enabled: true, start: 22, end: 7 },
            vipSenders: [],
            timezone: 'America/New_York',
          }
        : {},
    mutate: async (fn: any, args: any) => {
      const name = getFunctionName(fn);
      calls.push({ fn: name, args });
      if (name.endsWith(':recordCode'))
        return {
          created: true,
          ...(options.obligationId === null ? {} : { obligationId: options.obligationId ?? 'ob-code' }),
        };
      if (name.endsWith(':holdMailPush')) return { held: true };
      return { notificationId: `n-${args.messageId}`, created: true };
    },
    dispatch: async (_userId: string, notificationId: string, _deps: unknown, opts: any) => {
      dispatches.push({ notificationId, options: opts });
      return { sent: 1, failed: 0 };
    },
    confirm: async () => null,
    clock: () => LATE,
    ...(options.needsYou === undefined
      ? {}
      : {
          needsYou: () => options.needsYou!,
          deliverObligations: async (userId: string, ids: string[]) => {
            delivered.push({ userId, ids });
            if (options.deliverThrows) throw new Error('APNs down');
          },
        }),
  };
  const names = () => calls.map((call) => call.fn.split(':')[1]);
  return { deps, calls, names, dispatches, delivered };
}

// A failed assertion must not leave the fake clock on for later tests.
afterEach(() => setSystemTime());

describe('ingest scan for a flag user (S5, S6)', () => {
  test('a code opens a code obligation and pushes through it, with no urgent_mail row', async () => {
    setSystemTime(new Date(LATE));
    const run = harness({ needsYou: true, quiet: true });
    const result = await detectUrgentMailAndCodes(ROW, [message(CODE_MAIL)], run.deps);
    expect(result).toEqual({ codes: 1, urgent: 0, newMail: 0 });
    expect(run.names()).toEqual(['recordCode']);
    expect(run.calls[0].args).toMatchObject({
      needsYou: true,
      sender: CODE_MAIL.from,
      subject: CODE_MAIL.subject,
      code: '284917',
    });
    // Quiet hours do not hold it: the obligation claim pushes a code at once.
    expect(run.delivered).toEqual([{ userId: 'user-1', ids: ['ob-code'] }]);
    expect(run.dispatches).toEqual([]);
  });

  test('a failed code push or a code without an obligation id does not fail the scan', async () => {
    setSystemTime(new Date(LATE));
    const failing = harness({ needsYou: true, deliverThrows: true });
    expect((await detectUrgentMailAndCodes(ROW, [message(CODE_MAIL)], failing.deps)).codes).toBe(1);
    const none = harness({ needsYou: true, obligationId: null });
    await detectUrgentMailAndCodes(ROW, [message(CODE_MAIL)], none.deps);
    expect(none.delivered).toEqual([]);
  });

  test('ordinary mail writes no mail_message row and no push', async () => {
    const run = harness({ needsYou: true });
    const result = await detectUrgentMailAndCodes(ROW, [message()], run.deps);
    expect(result).toEqual({ codes: 0, urgent: 0, newMail: 0 });
    expect(run.calls).toEqual([]);
    expect(run.dispatches).toEqual([]);
  });

  test('urgent language without a code keeps urgent_mail in phase 1', async () => {
    setSystemTime(new Date(LATE));
    const run = harness({ needsYou: true });
    const result = await detectUrgentMailAndCodes(ROW, [message(URGENT_MAIL)], run.deps);
    expect(result.urgent).toBe(1);
    expect(run.names()).toEqual(['queueUrgentMailNotification']);
    expect(run.dispatches).toHaveLength(1);
  });
});

describe('ingest scan with the flag off', () => {
  test('the old behavior: a new-mail row, and a code as urgent mail with codeAvailable', async () => {
    setSystemTime(new Date(LATE));
    const off = harness({ needsYou: false });
    await detectUrgentMailAndCodes(
      ROW,
      [message(), message({ ...CODE_MAIL, providerMessageId: 'msg-2' })],
      off.deps,
    );
    expect(off.names()).toEqual(['queueMailNotification', 'recordCode', 'queueUrgentMailNotification']);
    expect(off.calls[1].args.needsYou).toBeUndefined();
    expect(off.dispatches.at(-1)).toEqual({ notificationId: 'n-msg-2', options: { codeAvailable: true } });
    expect(off.delivered).toEqual([]);
  });

  test('S6 for all users: quiet hours hold new mail but never the push that carries a code', async () => {
    setSystemTime(new Date(LATE));
    const run = harness({ quiet: true });
    const result = await detectUrgentMailAndCodes(
      ROW,
      [message(), message({ ...CODE_MAIL, providerMessageId: 'msg-2' })],
      run.deps,
    );
    expect(result).toEqual({ codes: 1, urgent: 1, newMail: 1, held: 1 });
    expect(run.calls.find((call) => call.fn.endsWith(':holdMailPush'))?.args.notificationId).toBe('n-msg-1');
    expect(run.dispatches).toEqual([{ notificationId: 'n-msg-2', options: { codeAvailable: true } }]);
  });
});

describe('Jev sweep and the flag', () => {
  function sweepDeps(needsYou: boolean | undefined, options: { deliverThrows?: boolean } = {}) {
    const mutations: Array<{ fn: string; args: any }> = [];
    const delivered: string[][] = [];
    const item = { ...mailInput(), leaseId: 'lease' };
    let claimed = false;
    const deps: any = {
      loadJevPolicy: async () => ({ preferences: DEFAULT_JEV_PREFERENCES, corrections: [], revision: 1 }),
      resolveClassifierRuntime: async () => ({
        userId: 'u',
        source: 'lab86',
        apiKey: 'test-only',
        model: JEV,
      }),
      evaluateClassifier: async () => responseFor(item, { due: 'soon' }),
      recordClassifierUsage: async () => undefined,
      convexMutation: async (fn: any, args: any) => {
        mutations.push({ fn: getFunctionName(fn), args });
        if (args.items)
          return { stored: args.items.length, ...(args.needsYou ? { obligationIds: ['ob1', 'ob2'] } : {}) };
        if (claimed) return { items: [], moreRemaining: false };
        claimed = true;
        return { items: [item], moreRemaining: false };
      },
      ...(needsYou === undefined
        ? {}
        : {
            needsYouFor: () => needsYou,
            deliverObligations: async (_userId: string, ids: string[]) => {
              delivered.push(ids);
              if (options.deliverThrows) throw new Error('down');
            },
          }),
    };
    return { deps, mutations, delivered };
  }

  test('in the flag: the claim records it, the store syncs, and the returned ids are pushed', async () => {
    const run = sweepDeps(true);
    expect(await runJevSweep('u', run.deps)).toEqual({ classified: 1, moreRemaining: false });
    expect(run.mutations[0]).toMatchObject({ fn: 'jev:claimPending', args: { needsYou: true } });
    expect(run.mutations[1]).toMatchObject({ fn: 'jev:storeAssessments', args: { needsYou: true } });
    expect(run.mutations[1].args.items[0].assessment.due).toBe('soon');
    expect(run.delivered).toEqual([['ob1', 'ob2']]);
  });

  test('out of the flag: the claim says so, the store gets no flag, and nothing pushes', async () => {
    const run = sweepDeps(false);
    await runJevSweep('u', run.deps);
    expect(run.mutations[0].args.needsYou).toBe(false);
    expect(run.mutations[1].args.needsYou).toBeUndefined();
    expect(run.delivered).toEqual([]);
    // Dependencies without the flag: the calls are the same as before Needs you.
    const legacy = sweepDeps(undefined);
    await runJevSweep('u', legacy.deps);
    expect('needsYou' in legacy.mutations[0].args).toBe(false);
  });

  test('each stored batch pushes at once, so a later failed batch cannot drop them', async () => {
    const run = sweepDeps(true);
    const item = { ...mailInput(), leaseId: 'lease' };
    let claims = 0;
    run.deps.convexMutation = async (_fn: any, args: any) => {
      if (args.items) return { stored: args.items.length, obligationIds: ['ob1'] };
      claims += 1;
      if (claims === 1) return { items: [item], moreRemaining: true };
      throw new Error('claim failed');
    };
    await expect(runJevSweep('u', run.deps)).rejects.toThrow('claim failed');
    expect(run.delivered).toEqual([['ob1']]);
  });

  test('a failed push does not fail the sweep', async () => {
    const run = sweepDeps(true, { deliverThrows: true });
    expect((await runJevSweep('u', run.deps)).classified).toBe(1);
  });
});

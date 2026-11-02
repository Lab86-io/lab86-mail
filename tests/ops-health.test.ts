import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { createOpsHealthPost } from '../app/api/cron/ops-health/route';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import type { CostAlarmMessage } from '../lib/notifications/cost-alarm';
import {
  type OpsAlarmDependencies,
  opsAlarmEmail,
  resetOpsAlarmWarningsForTest,
  runOpsAlarm,
} from '../lib/notifications/ops-alarm';
import {
  breachesFailureRate,
  breachesSilence,
  classifyOpsError,
  cleanOpsErrorClass,
  evaluateOpsKind,
  mergeOpsHours,
  modelCallOutcome,
  OPS_CLAIM_LEASE_MS,
  OPS_HOUR_MS,
  OPS_MIN_INCIDENT_MS,
  OPS_POLICY,
  OPS_WINDOW_ROW_LIMIT,
  type OpsBucketRow,
  type OpsWatchState,
  opsDay,
  opsHourStart,
  opsModelKind,
  opsStateKey,
  opsWindow,
  releaseOpsNotice,
  settleOpsNotice,
  toolCallOutcome,
} from '../lib/ops/health';

// 2026-10-26 14:20 UTC: inside the real outage.
const NOW = Date.UTC(2026, 9, 26, 14, 20);
const HOUR = OPS_HOUR_MS;
const SECRET = 'ops-health-test-secret';

function bucket(overrides: Partial<OpsBucketRow> = {}): OpsBucketRow {
  return { hourStart: opsHourStart(NOW), kind: 'model:jev', ok: 0, failed: 0, ...overrides };
}

describe('names and classes', () => {
  test('each model feature has one group, and an unknown feature still counts', () => {
    expect(opsModelKind('agent')).toBe('model:chat');
    expect(opsModelKind('albatross_step')).toBe('model:chat');
    expect(opsModelKind('albatross_step_auto')).toBe('model:chat');
    expect(opsModelKind('daily_brief_prose')).toBe('model:brief');
    expect(opsModelKind('daily_report_insight')).toBe('model:brief');
    expect(opsModelKind('brief_preparation')).toBe('model:brief');
    expect(opsModelKind('jev_mail_body')).toBe('model:jev');
    expect(opsModelKind('narrative_write')).toBe('model:narrative');
    expect(opsModelKind('summarize_thread')).toBe('model:other');
    expect(opsModelKind('a_new_feature')).toBe('model:other');
  });

  test('the error class is a fixed word, so provider text never reaches a rollup', () => {
    expect(classifyOpsError('User not found')).toBe('auth');
    expect(classifyOpsError('No auth credentials found')).toBe('auth');
    expect(classifyOpsError('Request failed with status 401')).toBe('auth');
    expect(classifyOpsError('Classifier evaluation unavailable (not_configured).')).toBe('auth');
    expect(classifyOpsError('Insufficient credits')).toBe('credit');
    expect(classifyOpsError('Too many requests')).toBe('rate_limit');
    expect(classifyOpsError('Classifier evaluation unavailable (timeout).')).toBe('timeout');
    expect(classifyOpsError('The operation was aborted due to timeout')).toBe('timeout');
    expect(classifyOpsError('fetch failed')).toBe('network');
    expect(classifyOpsError('Classifier evaluation unavailable (invalid_response).')).toBe('parse');
    expect(classifyOpsError('Incomplete brief response')).toBe('parse');
    expect(classifyOpsError('Classifier evaluation unavailable (provider).')).toBe('server');
    expect(classifyOpsError('502 Bad Gateway')).toBe('server');
    expect(classifyOpsError('The edition used its model budget.')).toBe('budget');
    expect(classifyOpsError('The turn was stopped before it finished.')).toBe('stopped');
    expect(classifyOpsError('Mail from a real person about lunch')).toBe('other');
    expect(classifyOpsError(undefined)).toBe('other');
  });

  test('a class from another writer must be a short plain word', () => {
    expect(cleanOpsErrorClass('tool_timeout')).toBe('tool_timeout');
    expect(cleanOpsErrorClass('Mail from a person')).toBeNull();
    expect(cleanOpsErrorClass(42)).toBeNull();
    expect(cleanOpsErrorClass(undefined)).toBeNull();
  });

  test('a stopped call is neither a success nor a failure', () => {
    expect(modelCallOutcome(true)).toEqual({ ok: true });
    expect(modelCallOutcome(false, 'User not found')).toEqual({ ok: false, errorClass: 'auth' });
    expect(modelCallOutcome(false, 'The turn was stopped before it finished.')).toBeNull();
  });

  test('tool outcomes read a new status and class without a code change', () => {
    expect(toolCallOutcome({ status: 'succeeded' })).toEqual({ ok: true, errorClass: 'none' });
    expect(toolCallOutcome({ status: 'failed', error: 'fetch failed' })).toEqual({
      ok: false,
      errorClass: 'network',
    });
    expect(toolCallOutcome({ status: 'unknown' })).toEqual({ ok: false, errorClass: 'unknown' });
    expect(toolCallOutcome({ status: 'failed', errorClass: 'tool_timeout' })).toEqual({
      ok: false,
      errorClass: 'tool_timeout',
    });
    expect(toolCallOutcome({ status: 'rejected' })).toEqual({ ok: null, errorClass: 'rejected' });
    expect(toolCallOutcome({ status: 'rejected', errorClass: 'invalid_args' })).toEqual({
      ok: null,
      errorClass: 'invalid_args',
    });
  });

  test('hours and days are UTC', () => {
    expect(opsHourStart(NOW)).toBe(Date.UTC(2026, 9, 26, 14));
    expect(opsDay(NOW)).toBe('2026-10-26');
  });
});

describe('the rules', () => {
  const jev = OPS_POLICY['model:jev'];

  test('the 10-26 pattern passes the rate, and one failure among many does not', () => {
    expect(breachesFailureRate(jev, { ok: 24, failed: 76 })).toBe(true);
    expect(breachesFailureRate(jev, { ok: 299, failed: 1 })).toBe(false);
  });

  test('failures with no success at all pass the rate', () => {
    expect(breachesFailureRate(jev, { ok: 0, failed: 15 })).toBe(true);
  });

  test('a few calls do not pass the rate, because of the minimum', () => {
    expect(breachesFailureRate(jev, { ok: 0, failed: 9 })).toBe(false);
    expect(breachesFailureRate(jev, { ok: 0, failed: 0 })).toBe(false);
  });

  test('silence needs earlier calls and no recent success', () => {
    const earlier = { hour: opsHourStart(NOW - 20 * HOUR), ok: 40, failed: 0 };
    expect(breachesSilence(jev, { hours: [earlier], lastOkAt: NOW - 20 * HOUR }, NOW)).toBe(true);
    expect(breachesSilence(jev, { hours: [earlier], lastOkAt: NOW - 2 * HOUR }, NOW)).toBe(false);
    expect(breachesSilence(jev, { hours: [], lastOkAt: NOW - 20 * HOUR }, NOW)).toBe(false);
  });

  test('a group that only ever failed is silent too', () => {
    const earlier = { hour: opsHourStart(NOW - 20 * HOUR), ok: 0, failed: 12 };
    expect(breachesSilence(jev, { hours: [earlier] }, NOW)).toBe(true);
  });

  test('an idle chat is not silence, but a failing idle chat is', () => {
    const chat = OPS_POLICY['model:chat'];
    const earlier = { hour: opsHourStart(NOW - 40 * HOUR), ok: 3, failed: 0 };
    expect(breachesSilence(chat, { hours: [earlier], lastOkAt: NOW - 40 * HOUR }, NOW)).toBe(false);
    const failing = { hour: opsHourStart(NOW - 2 * HOUR), ok: 0, failed: 2 };
    expect(breachesSilence(chat, { hours: [earlier, failing], lastOkAt: NOW - 40 * HOUR }, NOW)).toBe(true);
  });

  test('a kind with no silence rule never fires on silence', () => {
    const earlier = { hour: opsHourStart(NOW - 40 * HOUR), ok: 3, failed: 0 };
    expect(breachesSilence(OPS_POLICY.tool, { hours: [earlier] }, NOW)).toBe(false);
  });

  test('the once-a-day brief is not silent during a normal day', () => {
    const brief = OPS_POLICY['model:brief'];
    const lastEdition = NOW - 23 * HOUR;
    const hours = [{ hour: opsHourStart(lastEdition), ok: 12, failed: 0 }];
    expect(breachesSilence(brief, { hours, lastOkAt: lastEdition }, NOW)).toBe(false);
    expect(breachesSilence(brief, { hours, lastOkAt: lastEdition }, NOW + 6 * HOUR)).toBe(true);
  });

  test('shards sum, and the newest failure gives the class', () => {
    expect(
      opsWindow([
        bucket({ ok: 2, failed: 1, lastErrorClass: 'timeout', lastFailedAt: 10, lastOkAt: 7 }),
        bucket({ ok: 3, failed: 4, lastErrorClass: 'auth', lastFailedAt: 20, lastOkAt: 5 }),
      ]),
    ).toEqual({ ok: 5, failed: 5, errorClass: 'auth', lastOkAt: 7 });
    expect(opsWindow([])).toEqual({ ok: 0, failed: 0 });
  });

  test('hour counts replace, so a run that repeats counts nothing twice, and old hours go', () => {
    const hour = opsHourStart(NOW);
    const rows = [bucket({ ok: 2 }), bucket({ ok: 1, failed: 1 })];
    const once = mergeOpsHours([], rows, NOW);
    expect(once).toEqual([{ hour, ok: 3, failed: 1 }]);
    expect(mergeOpsHours(once, rows, NOW)).toEqual(once);
    const old = { hour: opsHourStart(NOW - 60 * HOUR), ok: 9, failed: 9 };
    expect(mergeOpsHours([old], rows, NOW)).toEqual(once);
  });

  test('the state key does not depend on the key order of a stored row', () => {
    const a: OpsWatchState = { hours: [{ hour: 1, ok: 2, failed: 3 }], lastOkAt: 4 };
    const b = { lastOkAt: 4, hours: [{ failed: 3, ok: 2, hour: 1 }] } as OpsWatchState;
    expect(opsStateKey(a)).toBe(opsStateKey(b));
    expect(opsStateKey({ ...a, incident: { reason: 'silence', openedAt: 1, ok: 0, failed: 0 } })).not.toBe(
      opsStateKey(a),
    );
  });
});

describe('one incident', () => {
  const outage = [
    bucket({ ok: 24, failed: 76, lastErrorClass: 'auth', lastFailedAt: NOW, lastOkAt: NOW - 1 }),
  ];
  const healthy = (at: number) => [bucket({ hourStart: opsHourStart(at), ok: 50, failed: 0, lastOkAt: at })];
  const opened = () => {
    const first = evaluateOpsKind('model:jev', { hours: [] }, outage, NOW);
    return settleOpsNotice(first.state, 'opened', NOW);
  };

  test('the first run claims one notice, with the counts and class', () => {
    const { state, notice } = evaluateOpsKind('model:jev', { hours: [] }, outage, NOW);
    expect(notice).toMatchObject({
      kind: 'model:jev',
      type: 'opened',
      reason: 'failure_rate',
      ok: 24,
      failed: 76,
      errorClass: 'auth',
      openedAt: NOW,
    });
    expect(state.incident).toMatchObject({ reason: 'failure_rate', claimedAt: NOW });
  });

  test('a healthy group has no incident and no notice', () => {
    const { state, notice } = evaluateOpsKind('model:jev', { hours: [] }, healthy(NOW), NOW);
    expect(notice).toBeNull();
    expect(state.incident).toBeUndefined();
  });

  test('a claimed notice does not go out twice, until its lease ends', () => {
    const first = evaluateOpsKind('model:jev', { hours: [] }, outage, NOW);
    expect(evaluateOpsKind('model:jev', first.state, outage, NOW + 60_000).notice).toBeNull();
    const late = evaluateOpsKind('model:jev', first.state, outage, NOW + OPS_CLAIM_LEASE_MS);
    expect(late.notice?.type).toBe('opened');
  });

  test('a released notice goes out on the next run', () => {
    const first = evaluateOpsKind('model:jev', { hours: [] }, outage, NOW);
    const next = evaluateOpsKind('model:jev', releaseOpsNotice(first.state), outage, NOW + 60_000);
    expect(next.notice?.type).toBe('opened');
    expect(releaseOpsNotice({ hours: [] })).toEqual({ hours: [] });
  });

  test('after its mail, an open incident is quiet', () => {
    const state = opened();
    expect(state.incident?.openedSentAt).toBe(NOW);
    expect(state.incident?.claimedAt).toBeUndefined();
    expect(evaluateOpsKind('model:jev', state, outage, NOW + 15 * 60_000).notice).toBeNull();
  });

  test('a short improvement does not close it, and neither does an empty window', () => {
    const state = opened();
    const soon = NOW + OPS_MIN_INCIDENT_MS - 60_000;
    expect(evaluateOpsKind('model:jev', state, healthy(soon), soon).notice).toBeNull();
    const later = NOW + OPS_MIN_INCIDENT_MS;
    expect(evaluateOpsKind('model:jev', state, [], later).state.incident?.recoveredAt).toBeUndefined();
  });

  test('a rate between half the limit and the limit stays open', () => {
    const state = opened();
    const later = NOW + 2 * HOUR;
    const rows = [bucket({ hourStart: opsHourStart(later), ok: 80, failed: 20, lastOkAt: later })];
    const next = evaluateOpsKind('model:jev', state, rows, later);
    expect(next.notice).toBeNull();
    expect(next.state.incident?.recoveredAt).toBeUndefined();
  });

  test('a healthy group sends one recovery notice, and then the row is clean', () => {
    const state = opened();
    const later = NOW + 2 * HOUR;
    const next = evaluateOpsKind('model:jev', state, healthy(later), later);
    expect(next.notice).toMatchObject({ type: 'recovered', openedAt: NOW });
    expect(evaluateOpsKind('model:jev', next.state, healthy(later), later + 60_000).notice).toBeNull();
    const closed = settleOpsNotice(next.state, 'recovered', later);
    expect(closed.incident).toBeUndefined();
    expect(evaluateOpsKind('model:jev', closed, healthy(later), later + 60_000).notice).toBeNull();
  });

  test('a new breach takes back a recovery that has no mail yet', () => {
    const state = opened();
    const later = NOW + 2 * HOUR;
    const recovering = evaluateOpsKind('model:jev', state, healthy(later), later).state;
    const bad = [bucket({ hourStart: opsHourStart(later), ok: 1, failed: 30, lastFailedAt: later })];
    const next = evaluateOpsKind('model:jev', releaseOpsNotice(recovering), bad, later + 60_000);
    expect(next.notice).toBeNull();
    expect(next.state.incident?.recoveredAt).toBeUndefined();
    expect(next.state.incident?.openedSentAt).toBe(NOW);
  });

  test('an incident that nobody heard of closes without a mail', () => {
    const first = evaluateOpsKind('model:jev', { hours: [] }, outage, NOW);
    const later = NOW + 2 * HOUR;
    const next = evaluateOpsKind('model:jev', releaseOpsNotice(first.state), healthy(later), later);
    expect(next.notice).toBeNull();
    expect(next.state.incident).toBeUndefined();
    expect(settleOpsNotice({ hours: [] }, 'opened', NOW)).toEqual({ hours: [] });
  });

  test('the silence rule gives one notice, with the last success', () => {
    const lastOkAt = NOW - 20 * HOUR;
    const hours = [{ hour: opsHourStart(lastOkAt), ok: 40, failed: 0 }];
    const { notice } = evaluateOpsKind('model:jev', { hours, lastOkAt }, [], NOW);
    expect(notice).toMatchObject({ type: 'opened', reason: 'silence', lastOkAt });
  });
});

describe('the mail', () => {
  const opened = {
    kind: 'model:jev' as const,
    type: 'opened' as const,
    reason: 'failure_rate' as const,
    ok: 24,
    failed: 76,
    errorClass: 'auth',
    openedAt: NOW,
  };

  test('says what failed, with counts and the class only', () => {
    const mail = opsAlarmEmail('opened', [opened], NOW);
    expect(mail.subject).toContain('Jev model calls');
    expect(mail.text).toContain('76% failed (76 of 100) in the last 2 hours');
    expect(mail.text).toContain('Last error class: auth');
    expect(mail.text).toContain('provider key');
    expect(mail.text).toContain('scripts/ops-report.ts');
  });

  test('a mail with another class does not talk about keys', () => {
    expect(opsAlarmEmail('opened', [{ ...opened, errorClass: 'timeout' }], NOW).text).not.toContain(
      'provider key',
    );
  });

  test('says how long a group was silent', () => {
    const silence = { ...opened, reason: 'silence' as const, ok: 0, failed: 2 };
    expect(opsAlarmEmail('opened', [{ ...silence, lastOkAt: NOW - 7 * HOUR }], NOW).text).toContain(
      'no successful call for 7 hours, and 2 failed',
    );
    expect(opsAlarmEmail('opened', [silence], NOW).text).toContain('no successful call in the saved hours');
  });

  test('the recovery mail says how long the incident was open', () => {
    const mail = opsAlarmEmail('recovered', [{ ...opened, type: 'recovered' }], NOW + 5 * HOUR);
    expect(mail.subject).toContain('recovered: Jev model calls');
    expect(mail.text).toContain('open for 5 hours');
    const short = opsAlarmEmail('recovered', [{ ...opened, type: 'recovered' }], NOW + 45 * 60_000);
    expect(short.text).toContain('open for 45 minutes');
  });
});

describe('the alarm in Convex', () => {
  let previousSecret: string | undefined;
  beforeAll(() => {
    previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
  });
  beforeEach(() => {
    resetOpsAlarmWarningsForTest();
    Date.now = () => clock;
  });
  afterEach(() => {
    Date.now = realNow;
  });
  const realNow = Date.now;
  let clock = NOW;

  const harness = () =>
    convexTest(schema, {
      '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
      '../convex/ai.ts': () => import('../convex/ai'),
      '../convex/opsHealth.ts': () => import('../convex/opsHealth'),
      '../convex/agentExecution.ts': () => import('../convex/agentExecution'),
      '../convex/briefJobs.ts': () => import('../convex/briefJobs'),
      '../convex/dailyReports.ts': () => import('../convex/dailyReports'),
    });
  type Harness = ReturnType<typeof harness>;

  const ENV = {
    LAB86_OWNER_ALERT_EMAIL: 'owner@lab86.test',
    RESEND_API_KEY: 'test-key',
    LAB86_NOTIFICATION_FROM: 'alarm@lab86.test',
  };

  /** Each call is a new process: all state must come from Convex. */
  function alarm(t: Harness, overrides: Partial<OpsAlarmDependencies> & { at?: number } = {}) {
    const sent: CostAlarmMessage[] = [];
    const deps: OpsAlarmDependencies = {
      env: () => ENV,
      now: () => overrides.at ?? clock,
      query: (async (ref: any, args: any) =>
        t.query(ref, { internalSecret: SECRET, ...args })) as OpsAlarmDependencies['query'],
      mutate: (async (ref: any, args: any) =>
        t.mutation(ref, { internalSecret: SECRET, ...args })) as OpsAlarmDependencies['mutate'],
      send: async (message) => {
        sent.push(message);
        return 'email_1';
      },
      ...overrides,
    };
    return { sent, run: () => runOpsAlarm(deps) };
  }

  async function usage(
    t: Harness,
    feature: string,
    calls: Array<{ ok: boolean; error?: string; source?: 'lab86' | 'byok' }>,
  ) {
    for (const call of calls)
      await t.mutation(api.ai.recordUsage, {
        internalSecret: SECRET,
        userId: 'user_ops',
        feature,
        source: call.source ?? 'lab86',
        provider: 'openrouter',
        model: 'test/model',
        estimatedCredits: 0,
        ok: call.ok,
        ...(call.error ? { error: call.error } : {}),
      });
  }

  const failing = (count: number) =>
    Array.from({ length: count }, () => ({ ok: false, error: 'User not found' }));
  const working = (count: number) => Array.from({ length: count }, () => ({ ok: true }));
  const buckets = (t: Harness) => t.run((ctx) => ctx.db.query('opsHealthBuckets').collect());
  /** One alarm pass with no mail: the two Convex calls of a run. */
  const pass = async (t: Harness) =>
    t.mutation(api.opsHealth.evaluate, {
      internalSecret: SECRET,
      now: clock,
      rows: await t.query(api.opsHealth.windowRows, { internalSecret: SECRET, now: clock }),
    });

  test('the 10-26 pattern, 76% failed, fires once, and recovers once', async () => {
    clock = NOW;
    const t = harness();
    await usage(t, 'jev_mail', [...failing(38), ...working(12)]);

    const first = alarm(t);
    expect(await first.run()).toMatchObject({ status: 'ran', notices: 1, sent: 1, failed: 0 });
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0].to).toBe('owner@lab86.test');
    expect(first.sent[0].text).toContain('76% failed (38 of 50)');
    expect(first.sent[0].text).toContain('auth');
    expect(first.sent[0].text).not.toContain('user_ops');
    expect(first.sent[0].text).not.toContain('User not found');

    // More cron runs in a row, each one a new process, with the outage still on.
    for (const minutes of [15, 30, 45, 60]) {
      clock = NOW + minutes * 60_000;
      await usage(t, 'jev_mail', [...failing(7), ...working(2)]);
      const next = alarm(t);
      expect(await next.run()).toMatchObject({ status: 'ran', notices: 0, sent: 0 });
      expect(next.sent).toEqual([]);
    }

    // The key is back. The bad hour leaves the window, and one recovery mail goes.
    clock = NOW + 3 * HOUR;
    await usage(t, 'jev_mail', working(20));
    const back = alarm(t);
    expect(await back.run()).toMatchObject({ status: 'ran', notices: 1, sent: 1 });
    expect(back.sent[0].subject).toContain('recovered');

    clock = NOW + 3 * HOUR + 15 * 60_000;
    const after = alarm(t);
    expect(await after.run()).toMatchObject({ notices: 0 });
    expect(after.sent).toEqual([]);
  });

  test('one failed call among many does not fire', async () => {
    clock = NOW;
    const t = harness();
    await usage(t, 'jev_mail', [...failing(1), ...working(60)]);
    const run = alarm(t);
    expect(await run.run()).toMatchObject({ status: 'ran', notices: 0 });
    expect(run.sent).toEqual([]);
  });

  test('"User not found" fires when the record path sees only failures', async () => {
    clock = NOW;
    const t = harness();
    await usage(t, 'jev_mail', failing(12));
    const rows = await buckets(t);
    expect(rows.reduce((sum, row) => sum + row.ok, 0)).toBe(0);
    expect(rows.reduce((sum, row) => sum + row.failed, 0)).toBe(12);
    const run = alarm(t);
    expect(await run.run()).toMatchObject({ sent: 1 });
    expect(run.sent[0].text).toContain('100% failed (12 of 12)');
    expect(run.sent[0].text).toContain('Last error class: auth');
  });

  test('a dead key that fails every group sends one mail, not one for each group', async () => {
    clock = NOW;
    const t = harness();
    await usage(t, 'jev_mail', failing(12));
    await usage(t, 'narrative_write', failing(12));
    await usage(t, 'daily_brief_prose', failing(6));
    const run = alarm(t);
    expect(await run.run()).toMatchObject({ notices: 3, sent: 1 });
    expect(run.sent).toHaveLength(1);
    for (const label of ['Jev model calls', 'Narrative model calls', 'Brief model calls'])
      expect(run.sent[0].subject).toContain(label);
  });

  test('an own key and a stopped turn do not count', async () => {
    clock = NOW;
    const t = harness();
    await usage(
      t,
      'jev_mail',
      failing(20).map((call) => ({ ...call, source: 'byok' as const })),
    );
    await usage(
      t,
      'agent',
      Array.from({ length: 20 }, () => ({
        ok: false,
        error: 'The turn was stopped before it finished.',
      })),
    );
    expect(await buckets(t)).toEqual([]);
    expect(await alarm(t).run()).toMatchObject({ status: 'ran', notices: 0 });
  });

  test('a failed mail gives the claim back, and the next run sends it', async () => {
    clock = NOW;
    const t = harness();
    await usage(t, 'jev_mail', failing(12));
    const error = console.error;
    console.error = () => undefined;
    try {
      const failingRun = alarm(t, {
        send: mock(async () => {
          throw new Error('Resend failed');
        }),
      });
      expect(await failingRun.run()).toMatchObject({ notices: 1, sent: 0, failed: 1 });
    } finally {
      console.error = error;
    }
    clock = NOW + 15 * 60_000;
    const retry = alarm(t);
    expect(await retry.run()).toMatchObject({ sent: 1 });
    expect(retry.sent).toHaveLength(1);
  });

  test('a run that stops after its claim loses the claim, so the mail is not lost', async () => {
    clock = NOW;
    const t = harness();
    await usage(t, 'jev_mail', failing(12));
    await pass(t);
    clock = NOW + 60_000;
    const during = alarm(t);
    expect(await during.run()).toMatchObject({ notices: 0 });
    clock = NOW + OPS_CLAIM_LEASE_MS;
    const later = alarm(t);
    expect(await later.run()).toMatchObject({ sent: 1 });
  });

  test('a sent mail with a failed settle sends no second mail until its lease ends', async () => {
    clock = NOW;
    const t = harness();
    await usage(t, 'jev_mail', failing(12));
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      clock = NOW + 60_000;
      const settle = api.opsHealth.settleNotices;
      const lost = alarm(t, {
        mutate: (async (ref: any, args: any) => {
          if (ref === settle) throw new Error('Convex is busy');
          return t.mutation(ref, { internalSecret: SECRET, ...args });
        }) as OpsAlarmDependencies['mutate'],
      });
      expect(await lost.run()).toMatchObject({ sent: 1, failed: 0 });
      expect(lost.sent).toHaveLength(1);
      clock = NOW + 120_000;
      const next = alarm(t);
      expect(await next.run()).toMatchObject({ notices: 0 });
      expect(next.sent).toHaveLength(0);
    } finally {
      error.mockRestore();
    }
  });

  test('silence fires after a group stops, and a return closes it', async () => {
    clock = NOW;
    const t = harness();
    await usage(t, 'jev_mail', working(30));
    expect(await alarm(t).run()).toMatchObject({ notices: 0 });
    clock = NOW + 10 * HOUR;
    const silent = alarm(t);
    expect(await silent.run()).toMatchObject({ sent: 1 });
    expect(silent.sent[0].text).toContain('no successful call for 10 hours');
    clock = NOW + 11 * HOUR;
    await usage(t, 'jev_mail', working(3));
    const back = alarm(t);
    expect(await back.run()).toMatchObject({ sent: 1 });
    expect(back.sent[0].subject).toContain('recovered');
  });

  test('the cron reads at most its two hours of rows, and an idle kind writes nothing', async () => {
    clock = NOW;
    const t = harness();
    await t.run(async (ctx) => {
      // Old rows must not count, and the read must not reach them.
      for (let hours = 2; hours < 40; hours += 1)
        await ctx.db.insert('opsHealthBuckets', {
          hourStart: opsHourStart(NOW) - hours * HOUR,
          kind: 'model:jev',
          shard: 0,
          ok: 0,
          failed: 100,
        });
    });
    await usage(t, 'jev_mail', working(3));
    const rows = await t.query(api.opsHealth.windowRows, { internalSecret: SECRET, now: clock });
    expect(rows.length).toBeLessThanOrEqual(OPS_WINDOW_ROW_LIMIT);
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows.every((row) => row.hourStart === opsHourStart(NOW))).toBe(true);
    const result = await t.mutation(api.opsHealth.evaluate, { internalSecret: SECRET, now: clock, rows });
    expect(result.notices).toEqual([]);
    const watches = await t.run((ctx) => ctx.db.query('opsHealthWatch').collect());
    expect(watches.map((row) => row.kind)).toEqual(['model:jev']);
  });

  test('a run with no new data does not write the watch row again', async () => {
    clock = NOW;
    const t = harness();
    await usage(t, 'jev_mail', working(3));
    await pass(t);
    const before = await t.run((ctx) => ctx.db.query('opsHealthWatch').first());
    clock = NOW + 60_000;
    await pass(t);
    const after = await t.run((ctx) => ctx.db.query('opsHealthWatch').first());
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  test('every function needs the internal secret', async () => {
    const t = harness();
    await expect(t.query(api.opsHealth.windowRows, { now: NOW })).rejects.toThrow();
    await expect(t.mutation(api.opsHealth.evaluate, { now: NOW, rows: [] })).rejects.toThrow();
    await expect(t.mutation(api.opsHealth.settleNotices, { now: NOW, notices: [] })).rejects.toThrow();
    await expect(t.mutation(api.opsHealth.releaseNotices, { now: NOW, notices: [] })).rejects.toThrow();
    await expect(t.query(api.opsHealth.bucketsPage, { since: 0 })).rejects.toThrow();
    await expect(t.query(api.opsHealth.toolRollupsPage, { sinceDay: '2026-01-01' })).rejects.toThrow();
  });

  test('a tool call counts once, in its bucket and in its daily row', async () => {
    clock = NOW;
    const t = harness();
    const identity = { internalSecret: SECRET, userId: 'user_ops', runId: 'run_1' };
    const start = (key: string, toolName: string) =>
      t.mutation(api.agentExecution.beginTool, { ...identity, key, toolName, mutating: true });
    await start('a', 'document_create');
    await t.mutation(api.agentExecution.finishTool, {
      ...identity,
      key: 'a',
      status: 'unknown',
      error: 'lost',
    });
    // A later write over `unknown` is not a second call.
    await t.mutation(api.agentExecution.finishTool, { ...identity, key: 'a', status: 'succeeded' });
    await start('b', 'document_create');
    await t.mutation(api.agentExecution.finishTool, { ...identity, key: 'b', status: 'succeeded' });
    await start('c', 'search_mail');
    await t.mutation(api.agentExecution.finishTool, {
      ...identity,
      key: 'c',
      status: 'failed',
      error: 'fetch failed',
    });

    const rows = await buckets(t);
    expect(rows.every((row) => row.kind === 'tool')).toBe(true);
    expect(rows.reduce((sum, row) => sum + row.ok, 0)).toBe(1);
    expect(rows.reduce((sum, row) => sum + row.failed, 0)).toBe(2);
    const tools = await t.query(api.opsHealth.toolRollupsPage, {
      internalSecret: SECRET,
      sinceDay: '2026-10-26',
    });
    expect(tools.isDone).toBe(true);
    expect(tools.rows.map((row) => [row.toolName, row.errorClass, row.count]).sort()).toEqual([
      ['document_create', 'none', 1],
      ['document_create', 'unknown', 1],
      ['search_mail', 'network', 1],
    ]);
    expect(JSON.stringify(tools.rows)).not.toContain('user_ops');
    expect(
      await t.query(api.opsHealth.toolRollupsPage, { internalSecret: SECRET, sinceDay: '2026-10-27' }),
    ).toMatchObject({
      rows: [],
    });
  });

  test('each edition counts once, at the end of its job, with the last attempt result', async () => {
    clock = NOW;
    const t = harness();
    const caller = { internalSecret: SECRET, userId: 'user_ops' };
    const edition = async (reportId: string, fallback: boolean) => {
      const { jobId }: any = await t.mutation(api.briefJobs.enqueue, {
        ...caller,
        kind: 'daily',
        edition: 'morning',
        reportId,
        timezone: 'UTC',
      });
      const owned = { ...caller, id: jobId, token: `token-${reportId}` };
      await t.mutation(api.briefJobs.claim, owned);
      await t.mutation(api.dailyReports.recordEditionTelemetry, {
        ...caller,
        reportId,
        kind: 'morning',
        timeMs: 1,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        calls: 1,
        fallback,
        attempts: 1,
      });
      await t.mutation(api.briefJobs.settle, owned);
      // A new edition supersedes this one's job row, so the next call can queue.
      await t.run(async (ctx) => {
        await ctx.db.delete(jobId);
      });
    };
    await edition('edition-1', true);
    await edition('edition-2', true);
    const rows = await buckets(t);
    expect(rows.reduce((sum, row) => sum + row.failed, 0)).toBe(2);
    const run = alarm(t);
    expect(await run.run()).toMatchObject({ sent: 1 });
    expect(run.sent[0].subject).toContain('Brief editions');
    expect(run.sent[0].text).toContain('100% failed (2 of 2)');
  });

  test('a mail with no address or no mail keys sends nothing, and warns once', async () => {
    const t = harness();
    const warn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (message: unknown) => warnings.push(message);
    try {
      const empty = alarm(t, { env: () => ({ LAB86_OWNER_ALERT_EMAIL: '  ' }) });
      expect(await empty.run()).toEqual({ status: 'unconfigured', missing: 'recipient' });
      expect(await empty.run()).toEqual({ status: 'unconfigured', missing: 'recipient' });
      const noKeys = alarm(t, { env: () => ({ LAB86_OWNER_ALERT_EMAIL: 'owner@lab86.test' }) });
      expect(await noKeys.run()).toEqual({ status: 'unconfigured', missing: 'email' });
      expect(warnings).toHaveLength(2);
    } finally {
      console.warn = warn;
    }
  });

  test('the cron posts to the route, and only with its settings', async () => {
    const t = harness();
    const saved = { fetch: globalThis.fetch, url: process.env.LAB86_MAIL_PUBLIC_URL };
    const posts: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      posts.push({ url, init });
      return new Response('{}', { status: 202 });
    }) as unknown as typeof fetch;
    const error = console.error;
    console.error = () => undefined;
    try {
      delete process.env.LAB86_MAIL_PUBLIC_URL;
      await t.action(internal.opsHealth.tick, {});
      expect(posts).toEqual([]);
      process.env.LAB86_MAIL_PUBLIC_URL = 'https://mail.example.test/';
      await t.action(internal.opsHealth.tick, {});
      expect(posts.map((post) => post.url)).toEqual(['https://mail.example.test/api/cron/ops-health']);
      expect((posts[0].init.headers as Record<string, string>)['x-lab86-internal-secret']).toBe(SECRET);
    } finally {
      console.error = error;
      globalThis.fetch = saved.fetch;
      if (saved.url === undefined) delete process.env.LAB86_MAIL_PUBLIC_URL;
      else process.env.LAB86_MAIL_PUBLIC_URL = saved.url;
    }
  });
});

describe('the alarm route', () => {
  const request = () => new NextRequest('https://mail.example.test/api/cron/ops-health', { method: 'POST' });
  const runNow = ((task: () => unknown) => {
    void task();
  }) as unknown as typeof import('next/server').after;

  test('rejects a caller with no internal secret', async () => {
    const runOpsAlarm = mock(
      async () => ({ status: 'ran', rows: 0, notices: 0, sent: 0, failed: 0 }) as const,
    );
    const post = createOpsHealthPost({ isInternalCronRequest: () => false, runOpsAlarm, after: runNow });
    expect((await post(request())).status).toBe(401);
    expect(runOpsAlarm).not.toHaveBeenCalled();
  });

  test('answers at once and runs in the background, and a failed run does not throw', async () => {
    const error = console.error;
    const info = console.info;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => logged.push(args);
    console.info = (...args: unknown[]) => logged.push(args);
    try {
      const sent = mock(async () => ({ status: 'ran', rows: 2, notices: 1, sent: 1, failed: 0 }) as const);
      const post = createOpsHealthPost({
        isInternalCronRequest: () => true,
        runOpsAlarm: sent,
        after: runNow,
      });
      const response = await post(request());
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true, started: true });
      await Promise.resolve();
      expect(sent).toHaveBeenCalledTimes(1);

      const broken = mock(async () => {
        throw new Error('Convex is down');
      });
      const failing = createOpsHealthPost({
        isInternalCronRequest: () => true,
        runOpsAlarm: broken,
        after: runNow,
      });
      expect((await failing(request())).status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(logged.length).toBe(2);
    } finally {
      console.error = error;
      console.info = info;
    }
  });
});

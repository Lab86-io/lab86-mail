import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { convexTest, type TestConvex } from 'convex-test';
import { NextRequest } from 'next/server';
import { createMailDigestPost } from '../app/api/cron/mail-digest/route';
import { createMailPushSettingsRoute } from '../app/api/mail/push-settings/route';
import { hourLabel } from '../components/settings/MailAlertsSettings';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { runLlmClassificationSweep } from '../lib/mail/llm-classify';
import { detectUrgentMailAndCodes, type UrgentScanMessage } from '../lib/mail/urgent-detectors';
import { promoteHeldPriorityMail, releaseDueMailDigests } from '../lib/notifications/mail-digest';
import {
  DEFAULT_MAIL_PUSH_SETTINGS,
  decideMailPush,
  digestCopy,
  inQuietHours,
  isVipSender,
  type MailPushSettings,
  mailPushSettingsFromRow,
  normalizeVipSender,
  normalizeVipSenders,
  quietHoursEndAt,
} from '../lib/notifications/mail-push';

const SECRET = 'mail-push-secret';
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

const settings = (overrides: Partial<MailPushSettings> = {}): MailPushSettings => ({
  ...DEFAULT_MAIL_PUSH_SETTINGS,
  quietHours: { enabled: true, start: 22, end: 7 },
  timezone: 'America/New_York',
  ...overrides,
});
// 2026-09-26 23:30 in New York (EDT, UTC-4).
const LATE = Date.parse('2026-09-27T03:30:00.000Z');
// 2026-09-27 14:00 in New York.
const AFTERNOON = Date.parse('2026-09-27T18:00:00.000Z');

describe('VIP senders', () => {
  test('addresses and domains normalize, and junk is dropped', () => {
    expect(normalizeVipSender(' Ann <ANN@Example.com> ')).toBe('ann@example.com');
    expect(normalizeVipSender('@Example.com')).toBe('@example.com');
    expect(normalizeVipSender('example.com')).toBe('@example.com');
    expect(normalizeVipSender('not a sender')).toBeNull();
    expect(normalizeVipSender('')).toBeNull();
    expect(normalizeVipSenders(['a@x.com', 'A@X.com', 7, 'x.com'])).toEqual(['a@x.com', '@x.com']);
    expect(normalizeVipSenders('a@x.com')).toEqual([]);
    expect(normalizeVipSenders(Array.from({ length: 250 }, (_, i) => `u${i}@x.com`))).toHaveLength(200);
  });

  test('an address matches exactly; a domain matches its subdomains', () => {
    const vip = ['boss@work.com', '@family.org'];
    expect(isVipSender('Boss <boss@work.com>', vip)).toBe(true);
    expect(isVipSender('other@work.com', vip)).toBe(false);
    expect(isVipSender('mom@family.org', vip)).toBe(true);
    expect(isVipSender('kid@mail.family.org', vip)).toBe(true);
    expect(isVipSender('x@notfamily.org', vip)).toBe(false);
    expect(isVipSender(null, vip)).toBe(false);
  });
});

describe('quiet hours', () => {
  test('windows can cross midnight and follow the user zone', () => {
    expect(inQuietHours(LATE, settings())).toBe(true);
    expect(inQuietHours(AFTERNOON, settings())).toBe(false);
    expect(inQuietHours(LATE, settings({ timezone: 'UTC' }))).toBe(true);
    expect(inQuietHours(AFTERNOON, settings({ quietHours: { enabled: true, start: 13, end: 15 } }))).toBe(
      true,
    );
    expect(inQuietHours(LATE, settings({ quietHours: { enabled: false, start: 22, end: 7 } }))).toBe(false);
    expect(inQuietHours(LATE, settings({ quietHours: { enabled: true, start: 5, end: 5 } }))).toBe(false);
    // A bad zone falls back to UTC instead of failing a push.
    expect(inQuietHours(LATE, settings({ timezone: 'Not/AZone' }))).toBe(true);
  });

  test('the hold lasts until quiet hours end', () => {
    expect(new Date(quietHoursEndAt(LATE, settings())).toISOString()).toBe('2026-09-27T11:00:00.000Z');
    expect(quietHoursEndAt(AFTERNOON, settings())).toBe(AFTERNOON);
  });
});

describe('push decisions', () => {
  test('VIP always pushes; quiet hours hold the rest; priority-only holds ordinary mail', () => {
    const quiet = settings({ vipSenders: ['boss@work.com'] });
    expect(decideMailPush({ now: LATE, settings: quiet, from: 'boss@work.com', priority: false })).toEqual({
      action: 'push',
      reason: 'vip',
    });
    expect(decideMailPush({ now: LATE, settings: quiet, from: 'x@y.com', priority: true })).toEqual({
      action: 'hold',
      reason: 'quiet_hours',
      until: Date.parse('2026-09-27T11:00:00.000Z'),
    });
    const priority = settings({ mode: 'priority', quietHours: { enabled: false, start: 22, end: 7 } });
    expect(decideMailPush({ now: AFTERNOON, settings: priority, from: 'x@y.com', priority: true })).toEqual({
      action: 'push',
      reason: 'priority',
    });
    expect(decideMailPush({ now: AFTERNOON, settings: priority, from: 'x@y.com', priority: false })).toEqual({
      action: 'hold',
      reason: 'priority_only',
      until: AFTERNOON + 60 * 60_000,
    });
    expect(
      decideMailPush({
        now: AFTERNOON,
        settings: DEFAULT_MAIL_PUSH_SETTINGS,
        from: 'x@y.com',
        priority: false,
      }),
    ).toEqual({ action: 'push', reason: 'all' });
  });

  test('digest text and stored settings', () => {
    expect(digestCopy(['Ann', 'Bob', 'Ann', 'Cy', 'Dee'], 5)).toEqual({
      title: '5 new emails',
      body: 'From Ann, Bob, and 2 others',
    });
    expect(digestCopy(['Ann', 'Bob'], 2).body).toBe('From Ann and Bob');
    expect(digestCopy(['Ann', 'Bob', 'Cy'], 3).body).toBe('From Ann, Bob, and 1 other');
    expect(digestCopy([], 1)).toEqual({ title: '1 new email', body: 'Open Mail to read them.' });
    expect(
      mailPushSettingsFromRow({
        mailPushMode: 'priority',
        quietHoursEnabled: true,
        quietHoursStart: 21,
        quietHoursEnd: 99,
        vipSenders: ['A@X.com'],
        timezone: 'Europe/Paris',
      }),
    ).toEqual({
      mode: 'priority',
      quietHours: { enabled: true, start: 21, end: 7 },
      vipSenders: ['a@x.com'],
      timezone: 'Europe/Paris',
    });
    expect(mailPushSettingsFromRow(null)).toEqual({ ...DEFAULT_MAIL_PUSH_SETTINGS });
    expect(hourLabel(0)).toBe('12 AM');
    expect(hourLabel(13)).toBe('1 PM');
    expect(hourLabel(12)).toBe('12 PM');
  });
});

describe('the ingest scan holds or pushes', () => {
  const ROW = { userId: 'u', accountId: 'acc', grantId: 'g', status: 'connected' } as any;
  const message = (overrides: Partial<UrgentScanMessage> = {}): UrgentScanMessage => ({
    providerMessageId: 'm1',
    providerThreadId: 't1',
    subject: 'Lunch?',
    from: 'Friend <friend@example.com>',
    receivedAt: LATE,
    snippet: '',
    textBody: 'Want to get lunch sometime next week?',
    ...overrides,
  });
  function harness(push: MailPushSettings, now: number) {
    const holds: any[] = [];
    const dispatched: string[] = [];
    const deps = {
      query: (async (ref: any) => (getFunctionName(ref).endsWith(':mailPushSettings') ? push : {})) as any,
      mutate: (async (_ref: any, args: any) => {
        if (args?.until !== undefined) {
          holds.push(args);
          return { held: true };
        }
        return { notificationId: `n_${args.messageId}`, created: true };
      }) as any,
      dispatch: (async (_userId: string, notificationId: string) => {
        dispatched.push(notificationId);
        return { sent: 1, failed: 0 };
      }) as any,
      confirm: (async () => null) as any,
      clock: () => now,
    };
    return { deps, holds, dispatched };
  }

  test('quiet hours hold new mail with its thread, and a VIP still pushes', async () => {
    const { deps, holds, dispatched } = harness(settings({ vipSenders: ['@work.com'] }), LATE);
    const result = await detectUrgentMailAndCodes(
      ROW,
      [message(), message({ providerMessageId: 'm2', from: 'Boss <boss@work.com>' })],
      deps,
    );
    expect(result).toEqual({ codes: 0, urgent: 0, newMail: 2, held: 1 });
    expect(dispatched).toEqual(['n_m2']);
    expect(holds[0]).toMatchObject({
      userId: 'u',
      notificationId: 'n_m1',
      reason: 'quiet_hours',
      until: Date.parse('2026-09-27T11:00:00.000Z'),
      accountId: 'acc',
      threadId: 't1',
      messageId: 'm1',
      sender: 'Friend <friend@example.com>',
    });
  });

  test('priority-only pushes urgent mail and holds the rest for the digest', async () => {
    const { deps, holds, dispatched } = harness(
      settings({ mode: 'priority', quietHours: { enabled: false, start: 22, end: 7 } }),
      AFTERNOON,
    );
    await detectUrgentMailAndCodes(
      ROW,
      [
        message({ receivedAt: AFTERNOON }),
        message({
          providerMessageId: 'm3',
          receivedAt: AFTERNOON,
          subject: 'Your verification code',
          from: 'Google <no-reply@accounts.google.com>',
          textBody: 'Your verification code is 284917. It expires in 10 minutes.',
        }),
      ],
      deps,
    );
    expect(holds.map((hold) => [hold.notificationId, hold.reason])).toEqual([['n_m1', 'priority_only']]);
    expect(dispatched).toEqual(['n_m3']);
  });
});

describe('digest release and priority promotion', () => {
  const push = settings({ mode: 'priority', quietHours: { enabled: true, start: 22, end: 7 } });
  function deps(overrides: Record<string, any> = {}) {
    const dispatched: string[] = [];
    const mutations: Array<[string, any]> = [];
    return {
      dispatched,
      mutations,
      deps: {
        query: (async (ref: any, args: any) => {
          const name = getFunctionName(ref);
          if (name.includes('dueMailDigestUsers')) return { userIds: ['u1', 'u2', 'u3'] };
          if (name.includes('priorityHeldMail')) return { notificationIds: ['n1', 'n2'] };
          return overrides.settings?.[args.userId] ?? push;
        }) as any,
        mutate: (async (ref: any, args: any) => {
          const name = getFunctionName(ref);
          mutations.push([name, args]);
          if (name.includes('claimMailDigest')) {
            if (args.userId === 'u3') throw new Error('convex down');
            return args.userId === 'u2'
              ? { kind: 'none', count: 0 }
              : { kind: 'digest', count: 3, notificationId: 'digest_1' };
          }
          return { released: args.notificationId === 'n1' };
        }) as any,
        dispatch: (async (_userId: string, id: string) => {
          dispatched.push(id);
          return { sent: 1, failed: 0 };
        }) as any,
        clock: () => AFTERNOON,
      },
    };
  }

  test('each due user gets one digest push, quiet users wait, and failures are counted', async () => {
    const h = deps();
    expect(await releaseDueMailDigests(h.deps)).toEqual({
      users: 3,
      digests: 1,
      singles: 0,
      quiet: 0,
      failed: 1,
    });
    expect(h.dispatched).toEqual(['digest_1']);
    const quiet = deps();
    quiet.deps.clock = () => LATE;
    expect(await releaseDueMailDigests(quiet.deps)).toMatchObject({ quiet: 3, digests: 0 });
  });

  test('held mail that now needs a reply pushes at once', async () => {
    const h = deps();
    expect(await promoteHeldPriorityMail('u1', h.deps)).toEqual({ pushed: 1 });
    expect(h.dispatched).toEqual(['n1']);
    const everyEmail = deps({ settings: { u1: DEFAULT_MAIL_PUSH_SETTINGS } });
    expect(await promoteHeldPriorityMail('u1', everyEmail.deps)).toEqual({ pushed: 0 });
    const quiet = deps();
    quiet.deps.clock = () => LATE;
    expect(await promoteHeldPriorityMail('u1', quiet.deps)).toEqual({ pushed: 0 });
  });

  test('a classification sweep promotes held mail only when it classified something', async () => {
    const previous = process.env.NEXT_PUBLIC_CONVEX_URL;
    process.env.NEXT_PUBLIC_CONVEX_URL = 'https://mail-push.convex.example';
    try {
      const after = mock(async () => ({ pushed: 0 }));
      await runLlmClassificationSweep('promote-user', async () => ({ classified: 2 }), after);
      await runLlmClassificationSweep('promote-user-2', async () => ({ classified: 0 }), after);
      expect(after.mock.calls).toEqual([['promote-user']] as any);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
      else process.env.NEXT_PUBLIC_CONVEX_URL = previous;
    }
  });
});

describe('routes', () => {
  const user = { userId: 'u1', email: 'u@example.com', name: 'U', source: 'clerk' as const };
  test('settings read and save through the internal functions', async () => {
    const mutate = mock(async (_ref: any, args: any) => ({ ...DEFAULT_MAIL_PUSH_SETTINGS, mode: args.mode }));
    const route = createMailPushSettingsRoute({
      requireCurrentUser: async () => user as any,
      enforceUserRateLimit: async () => undefined as any,
      query: (async () => DEFAULT_MAIL_PUSH_SETTINGS) as any,
      mutate: mutate as any,
    });
    const read = await route.GET();
    expect(await read.json()).toEqual({ ok: true, settings: DEFAULT_MAIL_PUSH_SETTINGS });
    const saved = await route.PUT(
      new Request('http://localhost/api/mail/push-settings', {
        method: 'PUT',
        headers: { 'x-user-timezone': 'Europe/Paris' },
        body: JSON.stringify({
          mode: 'priority',
          quietHours: { enabled: true, start: 21 },
          addVipSenders: ['a@b.com'],
        }),
      }),
    );
    expect(saved.status).toBe(200);
    expect((mutate.mock.calls[0] as any)[1]).toEqual({
      userId: 'u1',
      mode: 'priority',
      quietHoursEnabled: true,
      quietHoursStart: 21,
      quietHoursEnd: undefined,
      vipSenders: undefined,
      addVipSenders: ['a@b.com'],
      removeVipSenders: undefined,
      timezone: 'Europe/Paris',
    });
    const bad = await route.PUT(
      new Request('http://localhost/api/mail/push-settings', {
        method: 'PUT',
        body: JSON.stringify({ quietHours: { start: 24 } }),
      }),
    );
    expect(bad.status).toBe(400);
    mutate.mockImplementation(async () => {
      throw new Error('Enter an email address or a domain.');
    });
    const junk = await route.PUT(
      new Request('http://localhost/api/mail/push-settings', {
        method: 'PUT',
        body: JSON.stringify({ addVipSenders: ['nope'] }),
      }),
    );
    expect(await junk.json()).toEqual({ ok: false, error: 'Enter an email address or a domain.' });
  });

  test('the digest cron route needs the internal secret', async () => {
    const release = mock(async () => ({ users: 0, digests: 0, singles: 0, quiet: 0, failed: 0 }));
    const denied = createMailDigestPost({
      isInternalCronRequest: () => false,
      releaseDueMailDigests: release,
    });
    expect(
      (await denied(new NextRequest('http://localhost/api/cron/mail-digest', { method: 'POST' }))).status,
    ).toBe(401);
    const allowed = createMailDigestPost({
      isInternalCronRequest: () => true,
      releaseDueMailDigests: release,
    });
    expect(
      (await allowed(new NextRequest('http://localhost/api/cron/mail-digest', { method: 'POST' }))).status,
    ).toBe(202);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('Convex mail push holds and digests', () => {
  const modules = {
    '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
    '../convex/albatrossNotifications.ts': () => import('../convex/albatrossNotifications'),
    '../convex/albatrossWorkV2.ts': () => import('../convex/albatrossWorkV2'),
    '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
    '../convex/boards.ts': () => import('../convex/boards'),
  };
  const f = (api as any).albatrossNotifications;
  const auth = { internalSecret: SECRET, userId: 'push_user' };

  async function queueMail(t: TestConvex<typeof schema>, messageId: string, sender: string) {
    const { notificationId } = await t.mutation(f.queueMailNotification, {
      ...auth,
      accountId: 'acct',
      threadId: `thread_${messageId}`,
      messageId,
      sender,
      subject: 'Hello',
      snippet: '',
    });
    return notificationId;
  }

  test('settings save, VIP edits, and invalid hours', async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(f.mailPushSettings, auth)).toEqual({ ...DEFAULT_MAIL_PUSH_SETTINGS });
    const created = await t.mutation(f.saveMailPushSettings, {
      ...auth,
      mode: 'priority',
      quietHoursEnabled: true,
      quietHoursStart: 23,
      addVipSenders: ['Boss <boss@work.com>'],
      timezone: 'America/Chicago',
    });
    expect(created).toEqual({
      mode: 'priority',
      quietHours: { enabled: true, start: 23, end: 7 },
      vipSenders: ['boss@work.com'],
      timezone: 'America/Chicago',
    });
    const edited = await t.mutation(f.saveMailPushSettings, {
      ...auth,
      addVipSenders: ['@family.org'],
      removeVipSenders: ['boss@work.com'],
    });
    expect(edited.vipSenders).toEqual(['@family.org']);
    expect(edited.mode).toBe('priority');
    await expect(t.mutation(f.saveMailPushSettings, { ...auth, quietHoursEnd: 24 })).rejects.toThrow(
      'whole hours',
    );
    await expect(t.mutation(f.saveMailPushSettings, { ...auth, addVipSenders: ['junk'] })).rejects.toThrow(
      'Enter an email address or a domain.',
    );
    // The check-in preferences written alongside keep their defaults.
    const row = await t.run((ctx) =>
      ctx.db
        .query('albatrossNotificationPreferences')
        .withIndex('by_user', (q) => q.eq('userId', 'push_user'))
        .unique(),
    );
    expect(row).toMatchObject({
      timezone: 'America/Chicago',
      eveningCheckinEnabled: true,
      webPushEnabled: false,
    });
  });

  test('held mail becomes one digest; a single hold pushes as itself', async () => {
    const t = convexTest(schema, modules);
    const first = await queueMail(t, 'm1', 'Ann <ann@example.com>');
    const second = await queueMail(t, 'm2', 'Bob <bob@example.com>');
    const heldAt = Date.now();
    for (const [id, messageId, sender] of [
      [first, 'm1', 'Ann'],
      [second, 'm2', 'Bob'],
    ]) {
      await t.mutation(f.holdMailPush, {
        ...auth,
        notificationId: id,
        until: heldAt + 60_000,
        reason: 'priority_only',
        accountId: 'acct',
        threadId: `thread_${messageId}`,
        messageId,
        sender,
      });
    }
    expect(await t.query(f.dueMailDigestUsers, { internalSecret: SECRET, now: heldAt })).toEqual({
      userIds: [],
    });
    expect(await t.query((internal as any).albatrossNotifications.hasDueMailDigests, {})).toBe(false);
    expect(await t.mutation(f.claimMailDigest, { ...auth, now: heldAt })).toEqual({ kind: 'none', count: 0 });

    const later = heldAt + 61_000;
    expect(await t.query(f.dueMailDigestUsers, { internalSecret: SECRET, now: later })).toEqual({
      userIds: ['push_user'],
    });
    const claim = await t.mutation(f.claimMailDigest, { ...auth, now: later });
    expect(claim).toMatchObject({ kind: 'digest', count: 2 });
    const digest = await t.run((ctx) => ctx.db.get(claim.notificationId));
    expect(digest).toMatchObject({
      type: 'mail_message',
      title: '2 new emails',
      body: 'From Ann and Bob',
      deepLink: '/mail',
      status: 'delivered',
    });
    const cleared = await t.run((ctx) => ctx.db.get(first as Id<'albatrossNotifications'>));
    expect(cleared?.pushHeldUntil).toBeUndefined();
    expect(cleared?.pushHold?.digestId).toBe(claim.notificationId);

    const third = await queueMail(t, 'm3', 'Cy <cy@example.com>');
    await t.mutation(f.holdMailPush, {
      ...auth,
      notificationId: third,
      until: later,
      reason: 'quiet_hours',
      accountId: 'acct',
      threadId: 'thread_m3',
    });
    expect(await t.mutation(f.claimMailDigest, { ...auth, now: later + 1 })).toEqual({
      kind: 'single',
      count: 1,
      notificationId: String(third),
    });
  });

  test('a held message whose thread needs a reply is released for its own push', async () => {
    const t = convexTest(schema, modules);
    const id = await queueMail(t, 'm9', 'Ann <ann@example.com>');
    await t.mutation(f.holdMailPush, {
      ...auth,
      notificationId: id,
      until: Date.now() + 3_600_000,
      reason: 'priority_only',
      accountId: 'acct',
      threadId: 'thread_m9',
    });
    expect(await t.query(f.priorityHeldMail, auth)).toEqual({ notificationIds: [] });
    await t.run((ctx) =>
      ctx.db.insert('mailCorpusThreads', {
        userId: 'push_user',
        accountId: 'acct',
        grantId: 'g',
        provider: 'google',
        providerThreadId: 'thread_m9',
        subject: 'Hello',
        fromAddress: 'Ann <ann@example.com>',
        lastDate: 1,
        snippet: '',
        labels: ['INBOX'],
        unread: true,
        jevNeedsReply: true,
        yearMonth: '2026-09',
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    expect(await t.query(f.priorityHeldMail, auth)).toEqual({ notificationIds: [String(id)] });
    expect(await t.mutation(f.releaseHeldMailPush, { ...auth, notificationId: id })).toEqual({
      released: true,
    });
    expect(await t.mutation(f.releaseHeldMailPush, { ...auth, notificationId: id })).toEqual({
      released: false,
    });
    await expect(
      t.mutation(f.holdMailPush, {
        internalSecret: SECRET,
        userId: 'someone_else',
        notificationId: id,
        until: 1,
        reason: 'quiet_hours',
        accountId: 'acct',
        threadId: 't',
      }),
    ).rejects.toThrow('Notification not found.');
  });
});

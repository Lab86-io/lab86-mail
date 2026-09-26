import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { createAlbatrossNotificationsPost } from '../app/api/cron/albatross-notifications/route';
import { CENTER_NOTIFICATION_TYPES } from '../components/notifications/model';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { checkinIsDue } from '../lib/albatross/work-v2';
import { briefReadyFallbackBody } from '../lib/notifications/brief-ready-copy';
import {
  sendCheckinEmail,
  setNotificationDeliveryDependenciesForTest,
  transactionalEmailConfigured,
} from '../lib/notifications/delivery';

// Regression tests for the 2026-09-26 audit findings in notifications
// (WRK-3, UI-5/WRK-20, WRK-14, WRK-15, BRF-14, INF-4).

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossNotifications.ts': () => import('../convex/albatrossNotifications'),
  '../convex/albatrossWorkV2.ts': () => import('../convex/albatrossWorkV2'),
  '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
  '../convex/boards.ts': () => import('../convex/boards'),
};

const SECRET = 'notification-audit-secret';
const userId = 'notification_audit_user';
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

async function notify(t: Harness, type: string, createdAt: number, status = 'delivered') {
  return t.run((ctx) =>
    ctx.db.insert('albatrossNotifications', {
      userId,
      type,
      title: `${type} ${createdAt}`,
      body: 'Body',
      deepLink: '/',
      dedupeKey: `${type}:${createdAt}`,
      status,
      scheduledFor: createdAt,
      createdAt,
      updatedAt: createdAt,
    } as any),
  );
}

describe('WRK-3 and UI-5 notification center', () => {
  test('the center reads only its types, so mail rows cannot push real items out', async () => {
    const t = harness();
    await notify(t, 'brief_ready', 1);
    await notify(t, 'work_question', 2);
    for (let index = 0; index < 8; index += 1) await notify(t, 'mail_message', 100 + index);
    await notify(t, 'work_wake', 50);
    const asUser = t.withIdentity({ subject: userId });

    const legacy = await asUser.query(api.albatrossNotifications.liveCenter, { limit: 3 });
    // The old read takes the newest rows of every type: mail fills the page.
    expect(legacy.notifications.some((row: any) => ['brief_ready', 'work_question'].includes(row.type))).toBe(
      false,
    );

    const center = await asUser.query(api.albatrossNotifications.liveCenter, {
      limit: 3,
      types: [...CENTER_NOTIFICATION_TYPES],
    });
    expect(center.notifications.map((row: any) => row.type)).toEqual(['work_question', 'brief_ready']);
    expect(center.unread).toBe(2);

    const wake = await asUser.query(api.albatrossNotifications.liveCenter, {
      limit: 3,
      types: ['work_wake'],
    });
    expect(wake.notifications.map((row: any) => row.type)).toEqual(['work_wake']);
  });

  test('with the in-app center switched off, rows are not shown or counted', async () => {
    const t = harness();
    await notify(t, 'brief_ready', 1);
    await t.run((ctx) =>
      ctx.db.insert('albatrossNotificationPreferences', {
        userId,
        timezone: 'UTC',
        eveningCheckinEnabled: true,
        eveningCheckinLocalTime: '19:00',
        inAppEnabled: false,
        webPushEnabled: false,
        emailFallbackEnabled: false,
        emailFallbackDelayMinutes: 90,
        createdAt: 1,
        updatedAt: 1,
      } as any),
    );
    const center = await t
      .withIdentity({ subject: userId })
      .query(api.albatrossNotifications.liveCenter, { types: [...CENTER_NOTIFICATION_TYPES] });
    expect(center).toEqual({ unread: 0, notifications: [] });
  });
});

describe('WRK-14 fallback delivery sends only the open prompt', () => {
  test('after the reflection answer, delivery carries the tomorrow prompt', async () => {
    const t = harness();
    const ensured = await t.mutation(api.albatrossNotifications.ensureCheckin, {
      internalSecret: SECRET,
      userId,
      localDate: '2026-09-26',
      timezone: 'UTC',
    });
    const checkinId = ensured.checkin!._id as Id<'albatrossDailyCheckins'>;
    const before = await t.query(api.albatrossNotifications.deliveryContext, {
      internalSecret: SECRET,
      userId,
      checkinId,
    });
    expect(before?.notification?.dedupeKey).toBe('daily-checkin:2026-09-26:reflection');

    await t.mutation(api.albatrossNotifications.answerCheckin, {
      internalSecret: SECRET,
      userId,
      checkinId,
      promptKind: 'reflection',
      responseText: 'Filed the taxes.',
    });
    const after = await t.query(api.albatrossNotifications.deliveryContext, {
      internalSecret: SECRET,
      userId,
      checkinId,
    });
    expect(after?.notification?.dedupeKey).toBe('daily-checkin:2026-09-26:tomorrow');

    await t.mutation(api.albatrossNotifications.answerCheckin, {
      internalSecret: SECRET,
      userId,
      checkinId,
      promptKind: 'tomorrow',
      responseText: 'Call the landlord.',
    });
    const done = await t.query(api.albatrossNotifications.deliveryContext, {
      internalSecret: SECRET,
      userId,
      checkinId,
    });
    expect(done?.notification).toBeNull();
  });

  test('a reflection that completes Work retires its plan cards', async () => {
    const t = harness();
    const { workId, cardId } = await t.run(async (ctx) => {
      const workId = await ctx.db.insert('albatrossIntents', {
        userId,
        rawText: 'File the taxes',
        title: 'Taxes',
        source: 'text',
        status: 'ready',
        workState: 'active',
        agentState: 'idle',
        createdAt: 1,
        updatedAt: 1,
      } as any);
      const boardId = await ctx.db.insert('boards', {
        ownerUserId: userId,
        title: 'Personal',
        createdAt: 1,
        updatedAt: 1,
      });
      const columnId = await ctx.db.insert('boardColumns', {
        boardId,
        name: 'Todo',
        order: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      const cardId = await ctx.db.insert('cards', {
        boardId,
        columnId,
        userId,
        title: 'Gather W-2',
        order: 1,
        source: { kind: 'chat', intentId: String(workId) },
        createdAt: 1,
        updatedAt: 1,
      } as any);
      return { workId, cardId };
    });
    const checkinId = await t.run((ctx) =>
      ctx.db.insert('albatrossDailyCheckins', {
        userId,
        localDate: '2026-09-26',
        timezone: 'UTC',
        status: 'open',
        candidateItems: [{ kind: 'work', id: String(workId), title: 'Taxes', evidence: [] }],
        conversationId: 'c',
        createdAt: 1,
        updatedAt: 1,
      } as any),
    );
    await t.mutation(api.albatrossNotifications.answerCheckin, {
      internalSecret: SECRET,
      userId,
      checkinId,
      promptKind: 'reflection',
      responseText: 'Done.',
      completed: [{ kind: 'work', id: String(workId) }],
    });
    expect((await t.run((ctx) => ctx.db.get(workId)))?.workState).toBe('done');
    expect((await t.run((ctx) => ctx.db.get(cardId)))?.retiredByWorkId).toBe(String(workId));
  });
});

describe('BRF-14 brief push fallback line', () => {
  test('the line names only the parts that exist', () => {
    expect(briefReadyFallbackBody()).toBe('Your brief for today is ready to read.');
    expect(briefReadyFallbackBody({ events: 3 })).toBe('Today’s brief has 3 events on your calendar.');
    expect(briefReadyFallbackBody({ weather: true, tasks: 1, intent: true })).toBe(
      'Today’s brief has the weather, 1 task due and what you said you want to get done today.',
    );
  });

  test('queueBriefReady no longer promises weather or tomorrow', async () => {
    const t = harness();
    const queued = await t.mutation(api.albatrossNotifications.queueBriefReady, {
      internalSecret: SECRET,
      userId,
      reportId: 'report_1',
      localDate: '2026-09-26',
    });
    const row = await t.run((ctx) => ctx.db.get(queued.notificationId as Id<'albatrossNotifications'>));
    expect(row?.body).toBe('Your brief for today is ready to read.');
    expect(row?.body).not.toMatch(/weather|tomorrow/i);
  });
});

describe('WRK-15 check-in window', () => {
  test('the check-in stays due after one missed cron run', () => {
    const preference = {
      timezone: 'UTC',
      eveningCheckinEnabled: true,
      eveningCheckinLocalTime: '23:50',
      emailFallbackDelayMinutes: 90,
    };
    expect(checkinIsDue(preference, new Date('2026-09-26T23:49:00Z'))).toBe(false);
    expect(checkinIsDue(preference, new Date('2026-09-26T23:50:00Z'))).toBe(true);
    expect(checkinIsDue(preference, new Date('2026-09-26T23:59:00Z'))).toBe(true);
    expect(
      checkinIsDue({ ...preference, eveningCheckinLocalTime: '19:00' }, new Date('2026-09-26T21:30:00Z')),
    ).toBe(true);
  });
});

describe('INF-4 and WRK-14 cron email fallback', () => {
  function cronRequest(body: unknown) {
    return new NextRequest('http://localhost/api/cron/albatross-notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function setup(options: { configured: boolean }) {
    const mutations: Array<{ name: string; args: any }> = [];
    const emails: any[] = [];
    const post = createAlbatrossNotificationsPost({
      isInternalCronRequest: () => true,
      isStagingRuntime: () => false,
      now: () => new Date('2026-09-26T12:00:00Z'),
      transactionalEmailConfigured: () => options.configured,
      primaryEmail: async () => ({ to: 'owner@example.test', userName: 'Owner' }),
      sendCheckinEmail: (async (input: any) => {
        emails.push(input);
        return 'email_1';
      }) as any,
      dispatchNativeNotification: (async () => ({ sent: 0 })) as any,
      convexQuery: (async (fn: any) => {
        const name = getFunctionName(fn);
        if (name.endsWith('latestUnansweredCheckin'))
          return { _id: 'checkin_1', createdAt: Date.now() - 3 * 60 * 60_000 };
        if (name.endsWith('deliveryContext'))
          return {
            notification: {
              _id: 'notice_tomorrow',
              title: 'What do you want to get done tomorrow?',
              body: 'Reply in your own words.',
              deepLink: '/?checkin=checkin_1&prompt=tomorrow',
            },
            deliveries: [],
            subscriptions: [],
            mobileDevices: [],
            preference: null,
          };
        return null;
      }) as any,
      convexMutation: (async (fn: any, args: any) => {
        mutations.push({ name: getFunctionName(fn), args });
        return null;
      }) as any,
    });
    return { post, mutations, emails };
  }

  test('without email configuration no send is tried and no failure is recorded', async () => {
    const { post, mutations, emails } = setup({ configured: false });
    const response = await post(cronRequest({ userId, eveningCheckinLocalTime: '19:00' }));
    const body = await response.json();
    expect(body.email).toBeUndefined();
    expect(emails).toHaveLength(0);
    expect(mutations.some((call) => call.name.endsWith('recordDelivery'))).toBe(false);
  });

  test('with email configured the fallback sends the open prompt', async () => {
    const { post, mutations, emails } = setup({ configured: true });
    const response = await post(cronRequest({ userId, eveningCheckinLocalTime: '19:00' }));
    expect((await response.json()).email).toBe('sent');
    expect(emails[0].envelope).toMatchObject({
      id: 'notice_tomorrow',
      title: 'What do you want to get done tomorrow?',
    });
    expect(mutations.find((call) => call.name.endsWith('recordDelivery'))?.args).toMatchObject({
      channel: 'email',
      status: 'sent',
    });
  });

  test('transactional email needs a key, a sender, and the link secret', async () => {
    const keys = ['RESEND_API_KEY', 'LAB86_NOTIFICATION_FROM', 'LAB86_NOTIFICATION_LINK_SECRET'] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) delete process.env[key];
      expect(transactionalEmailConfigured()).toBe(false);
      process.env.RESEND_API_KEY = 'key';
      process.env.LAB86_NOTIFICATION_FROM = 'Albatross <a@example.test>';
      expect(transactionalEmailConfigured()).toBe(false);
      process.env.LAB86_NOTIFICATION_LINK_SECRET = 'secret';
      expect(transactionalEmailConfigured()).toBe(true);

      const sent: any[] = [];
      const restore = setNotificationDeliveryDependenciesForTest({
        hostedPublicUrl: () => 'https://mail.example.test',
        fetch: (async (_url: string, init: any) => {
          sent.push(JSON.parse(init.body));
          return { ok: true, json: async () => ({ id: 'email_2' }) } as Response;
        }) as any,
      });
      try {
        await sendCheckinEmail({
          envelope: {
            id: 'n',
            userId,
            title: 'What do you want to get done tomorrow?',
            body: 'Reply in your own words.',
            deepLink: '/',
          },
          to: 'owner@example.test',
        });
      } finally {
        restore();
      }
      expect(sent[0].subject).toBe('What do you want to get done tomorrow?');
      expect(sent[0].html).toContain('What do you want to get done tomorrow?');
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});

describe('WRK-15 repeat check-in pushes', () => {
  test('ensureCheckin lists only unread prompts as open', async () => {
    const t = harness();
    const first = await t.mutation(api.albatrossNotifications.ensureCheckin, {
      internalSecret: SECRET,
      userId,
      localDate: '2026-09-26',
      timezone: 'UTC',
    });
    expect(first.openNotificationIds).toHaveLength(2);
    await t.mutation(api.albatrossNotifications.answerCheckin, {
      internalSecret: SECRET,
      userId,
      checkinId: first.checkin!._id as Id<'albatrossDailyCheckins'>,
      promptKind: 'reflection',
      responseText: 'Filed the taxes.',
    });
    const again = await t.mutation(api.albatrossNotifications.ensureCheckin, {
      internalSecret: SECRET,
      userId,
      localDate: '2026-09-26',
      timezone: 'UTC',
    });
    expect(again.notificationIds).toHaveLength(2);
    expect(again.openNotificationIds).toHaveLength(1);
  });

  test('the due path pushes nothing when every prompt was read', async () => {
    const pushed: string[] = [];
    const post = createAlbatrossNotificationsPost({
      isInternalCronRequest: () => true,
      isStagingRuntime: () => false,
      now: () => new Date('2026-09-26T21:00:00Z'),
      transactionalEmailConfigured: () => false,
      dispatchNativeNotification: (async (_user: string, id: string) => {
        pushed.push(id);
        return { sent: 1 };
      }) as any,
      convexMutation: (async (fn: any) =>
        getFunctionName(fn).endsWith('ensureCheckin')
          ? {
              checkin: { _id: 'checkin_1', createdAt: Date.now() },
              notificationIds: ['a', 'b'],
              openNotificationIds: [],
            }
          : null) as any,
      convexQuery: (async (fn: any) =>
        getFunctionName(fn).endsWith('deliveryContext')
          ? {
              notification: { _id: 'b', title: 'T', body: 'B', deepLink: '/' },
              deliveries: [],
              subscriptions: [],
              mobileDevices: [{ token: 'device' }],
              preference: null,
            }
          : null) as any,
    });
    const response = await post(
      new NextRequest('http://localhost/api/cron/albatross-notifications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, timezone: 'UTC', eveningCheckinLocalTime: '19:00' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(pushed).toEqual([]);
  });
});

import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalAction, internalQuery, mutation, query } from './_generated/server';
import { fanOutInternalPost, now, requireInternalSecret } from './lib';

const DEFAULT_TZ = 'UTC';
const DEFAULT_CHECKIN_TIME = '19:00';
const DEFAULT_EMAIL_DELAY = 90;

async function authenticatedUserId(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new Error('Not authenticated');
  return identity.subject;
}

const notificationCallerArgs = {
  internalSecret: v.optional(v.string()),
  userId: v.optional(v.string()),
};

async function notificationCallerUserId(
  ctx: QueryCtx | MutationCtx,
  args: { internalSecret?: string; userId?: string },
) {
  if (args.internalSecret !== undefined) {
    requireInternalSecret(args.internalSecret);
    if (!args.userId) throw new Error('userId required with internal secret.');
    return args.userId;
  }
  return authenticatedUserId(ctx);
}

function localDayStartUtc(timezone: string, localDate: string) {
  const [year, month, day] = localDate.split('-').map(Number);
  const noonUtc = Date.UTC(year, month - 1, day, 12);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(noonUtc));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
    const represented = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    const offset = represented - noonUtc;
    return Date.UTC(year, month - 1, day) - offset;
  } catch {
    return Date.UTC(year, month - 1, day);
  }
}

function notificationPayload(input: {
  userId: string;
  type:
    | 'daily_checkin'
    | 'work_question'
    | 'approval'
    | 'completion_suggestion'
    | 'brief_ready'
    | 'agent_error';
  title: string;
  body: string;
  entityKind?: 'checkin' | 'work' | 'project' | 'area' | 'approval';
  entityId?: string;
  deepLink: string;
  dedupeKey: string;
  scheduledFor: number;
}) {
  const ts = now();
  return { ...input, status: 'queued' as const, createdAt: ts, updatedAt: ts };
}

export const getPreferences = query({
  args: {},
  handler: async (ctx) => {
    const userId = await authenticatedUserId(ctx);
    const row = await ctx.db
      .query('albatrossNotificationPreferences')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .unique();
    return (
      row || {
        userId,
        timezone: DEFAULT_TZ,
        eveningCheckinEnabled: true,
        eveningCheckinLocalTime: DEFAULT_CHECKIN_TIME,
        inAppEnabled: true,
        webPushEnabled: false,
        emailFallbackEnabled: true,
        emailFallbackDelayMinutes: DEFAULT_EMAIL_DELAY,
      }
    );
  },
});

export const savePreferences = mutation({
  args: {
    timezone: v.string(),
    eveningCheckinEnabled: v.boolean(),
    eveningCheckinLocalTime: v.string(),
    inAppEnabled: v.boolean(),
    webPushEnabled: v.boolean(),
    emailFallbackEnabled: v.boolean(),
    emailFallbackDelayMinutes: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    if (!/^\d{2}:\d{2}$/.test(args.eveningCheckinLocalTime)) throw new Error('Time must be HH:MM.');
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: args.timezone }).format(new Date());
    } catch {
      throw new Error('Invalid timezone.');
    }
    const existing = await ctx.db
      .query('albatrossNotificationPreferences')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .unique();
    const ts = now();
    const doc = {
      userId,
      ...args,
      emailFallbackDelayMinutes: Math.min(Math.max(Math.round(args.emailFallbackDelayMinutes), 15), 1_440),
      updatedAt: ts,
    };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return existing._id;
    }
    return ctx.db.insert('albatrossNotificationPreferences', { ...doc, createdAt: ts });
  },
});

export const upsertPushSubscription = mutation({
  args: { endpoint: v.string(), p256dh: v.string(), auth: v.string(), userAgent: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    const existing = await ctx.db
      .query('webPushSubscriptions')
      .withIndex('by_endpoint', (q) => q.eq('endpoint', args.endpoint))
      .unique();
    const ts = now();
    if (existing) {
      if (existing.userId !== userId) throw new Error('Subscription belongs to another user.');
      await ctx.db.patch(existing._id, { ...args, status: 'active', updatedAt: ts });
      return existing._id;
    }
    return ctx.db.insert('webPushSubscriptions', {
      userId,
      ...args,
      status: 'active',
      createdAt: ts,
      updatedAt: ts,
    });
  },
});

export const revokePushSubscription = mutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    const existing = await ctx.db
      .query('webPushSubscriptions')
      .withIndex('by_endpoint', (q) => q.eq('endpoint', args.endpoint))
      .unique();
    if (existing?.userId === userId)
      await ctx.db.patch(existing._id, { status: 'revoked', updatedAt: now() });
  },
});

export const liveCenter = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
    const rows = await ctx.db
      .query('albatrossNotifications')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .order('desc')
      .take(limit);
    return {
      unread: rows.filter((row) => row.status === 'queued' || row.status === 'delivered').length,
      notifications: rows,
    };
  },
});

export const markNotification = mutation({
  args: {
    notificationId: v.id('albatrossNotifications'),
    status: v.union(v.literal('read'), v.literal('acted'), v.literal('dismissed')),
  },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    const row = await ctx.db.get(args.notificationId);
    if (!row || row.userId !== userId) throw new Error('Notification not found.');
    const ts = now();
    await ctx.db.patch(args.notificationId, {
      status: args.status,
      updatedAt: ts,
      ...(args.status === 'read' ? { readAt: ts } : {}),
      ...(args.status === 'acted' ? { actedAt: ts, readAt: row.readAt ?? ts } : {}),
    });
  },
});

export const openCheckin = mutation({
  args: { checkinId: v.id('albatrossDailyCheckins') },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    const row = await ctx.db.get(args.checkinId);
    if (!row || row.userId !== userId) throw new Error('Check-in not found.');
    if (row.status === 'scheduled')
      await ctx.db.patch(row._id, { status: 'open', openedAt: now(), updatedAt: now() });
  },
});

export const answerCheckin = mutation({
  args: {
    ...notificationCallerArgs,
    checkinId: v.id('albatrossDailyCheckins'),
    responseText: v.string(),
    completed: v.optional(v.array(v.object({ kind: v.string(), id: v.string() }))),
  },
  handler: async (ctx, args) => {
    const userId = await notificationCallerUserId(ctx, args);
    const row = await ctx.db.get(args.checkinId);
    if (!row || row.userId !== userId) throw new Error('Check-in not found.');
    const responseText = args.responseText.trim().slice(0, 10_000);
    if (!responseText && !args.completed?.length) throw new Error('Tell Albatross what happened.');
    const completed = new Set((args.completed || []).map((entry) => `${entry.kind}:${entry.id}`));
    const changes: Array<{ kind: string; id: string; previousState?: string; nextState?: string }> = [];
    const ts = now();
    for (const item of row.candidateItems) {
      if (!completed.has(`${item.kind}:${item.id}`)) continue;
      if (item.kind === 'work') {
        const workId = ctx.db.normalizeId('albatrossIntents', item.id);
        if (workId) {
          const work = await ctx.db.get(workId);
          if (work?.userId === userId && work.workState !== 'done') {
            await ctx.db.patch(workId, {
              workState: 'done',
              status: 'done',
              agentState: 'idle',
              updatedAt: ts,
            });
            changes.push({
              kind: 'work',
              id: item.id,
              previousState: work.workState || work.status,
              nextState: 'done',
            });
          }
        }
      }
      if (item.kind === 'project') {
        const projectId = ctx.db.normalizeId('albatrossProjects', item.id);
        if (projectId) {
          const project = await ctx.db.get(projectId);
          if (project?.userId === userId && project.status !== 'done') {
            await ctx.db.patch(projectId, { status: 'done', completedAt: ts, updatedAt: ts });
            changes.push({ kind: 'project', id: item.id, previousState: project.status, nextState: 'done' });
          }
        }
      }
      if (item.kind === 'task') {
        const cardId = ctx.db.normalizeId('cards', item.id);
        if (cardId) {
          const card = await ctx.db.get(cardId);
          if (card?.userId === userId && !card.completedAt) {
            await ctx.db.patch(cardId, { completedAt: ts, updatedAt: ts });
            changes.push({ kind: 'task', id: item.id, previousState: 'open', nextState: 'done' });
          }
        }
      }
    }
    await ctx.db.patch(row._id, {
      status: 'answered',
      responseText,
      reconciledChanges: changes,
      answeredAt: ts,
      updatedAt: ts,
    });
    const notification = await ctx.db
      .query('albatrossNotifications')
      .withIndex('by_user_dedupe', (q) =>
        q.eq('userId', userId).eq('dedupeKey', `daily-checkin:${row.localDate}`),
      )
      .unique();
    if (notification)
      await ctx.db.patch(notification._id, {
        status: 'acted',
        actedAt: ts,
        readAt: notification.readAt ?? ts,
        updatedAt: ts,
      });
    return { changes };
  },
});

export const currentCheckin = query({
  args: {},
  handler: async (ctx) => {
    const userId = await authenticatedUserId(ctx);
    const rows = await ctx.db
      .query('albatrossDailyCheckins')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .order('desc')
      .take(2);
    return rows.find((row) => row.status === 'scheduled' || row.status === 'open') || null;
  },
});

export const getCheckin = query({
  args: { ...notificationCallerArgs, checkinId: v.id('albatrossDailyCheckins') },
  handler: async (ctx, args) => {
    const userId = await notificationCallerUserId(ctx, args);
    const row = await ctx.db.get(args.checkinId);
    return row?.userId === userId ? row : null;
  },
});

export const targets = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query('connectedAccounts').collect();
    const userIds = new Set(
      accounts.filter((account) => account.status === 'connected').map((account) => account.userId),
    );
    const calendars = await ctx.db.query('calendars').collect();
    const calendarTz = new Map<string, string>();
    for (const calendar of calendars) {
      if (!userIds.has(calendar.userId) || !calendar.timezone || /^(UTC|GMT|Etc\/)/i.test(calendar.timezone))
        continue;
      if (calendar.isPrimary || !calendarTz.has(calendar.userId))
        calendarTz.set(calendar.userId, calendar.timezone);
    }
    const out = [];
    for (const userId of userIds) {
      const preference = await ctx.db
        .query('albatrossNotificationPreferences')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .unique();
      out.push({
        userId,
        timezone: preference?.timezone || calendarTz.get(userId) || DEFAULT_TZ,
        eveningCheckinEnabled: preference?.eveningCheckinEnabled ?? true,
        eveningCheckinLocalTime: preference?.eveningCheckinLocalTime || DEFAULT_CHECKIN_TIME,
        inAppEnabled: preference?.inAppEnabled ?? true,
        webPushEnabled: preference?.webPushEnabled ?? false,
        emailFallbackEnabled: preference?.emailFallbackEnabled ?? true,
        emailFallbackDelayMinutes: preference?.emailFallbackDelayMinutes ?? DEFAULT_EMAIL_DELAY,
      });
    }
    return out;
  },
});

export const ensureCheckin = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    localDate: v.string(),
    timezone: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await ctx.db
      .query('albatrossDailyCheckins')
      .withIndex('by_user_date', (q) => q.eq('userId', args.userId).eq('localDate', args.localDate))
      .unique();
    if (existing) return { checkin: existing, created: false };
    const dayStart = localDayStartUtc(args.timezone, args.localDate);
    const dayEnd = dayStart + 36 * 60 * 60 * 1000;
    const [recentCompletions, activeWork, activeProjects, cards] = await Promise.all([
      ctx.db
        .query('completionEvents')
        .withIndex('by_user_completedAt', (q) => q.eq('userId', args.userId).gte('completedAt', dayStart))
        .take(50),
      ctx.db
        .query('albatrossIntents')
        .withIndex('by_user_updatedAt', (q) => q.eq('userId', args.userId).gte('updatedAt', dayStart))
        .order('desc')
        .take(30),
      ctx.db
        .query('albatrossProjects')
        .withIndex('by_user_updatedAt', (q) => q.eq('userId', args.userId).gte('updatedAt', dayStart))
        .order('desc')
        .take(20),
      ctx.db
        .query('cards')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .order('desc')
        .take(100),
    ]);
    const candidates: Array<{
      kind: 'work' | 'project' | 'task' | 'event' | 'artifact';
      id: string;
      title: string;
      suggestedState?: string;
      evidence: Array<{ kind: string; id: string; label?: string }>;
    }> = [];
    const completedIds = new Set(
      recentCompletions.map((event) => `${event.artifactKind}:${event.artifactId}`),
    );
    for (const work of activeWork) {
      if (work.updatedAt > dayEnd || work.workState === 'archived') continue;
      candidates.push({
        kind: 'work',
        id: String(work._id),
        title: work.title || work.rawText.slice(0, 120),
        suggestedState:
          completedIds.has(`intent:${String(work._id)}`) || work.workState === 'done' ? 'done' : 'moved',
        evidence: [{ kind: 'work', id: String(work._id), label: work.title }],
      });
    }
    for (const project of activeProjects) {
      if (project.updatedAt > dayEnd || project.status === 'archived') continue;
      candidates.push({
        kind: 'project',
        id: String(project._id),
        title: project.title,
        suggestedState: project.status === 'done' ? 'done' : 'moved',
        evidence: [{ kind: 'project', id: String(project._id), label: project.title }],
      });
    }
    for (const card of cards
      .filter((card) => card.updatedAt >= dayStart && card.updatedAt <= dayEnd)
      .slice(0, 30)) {
      candidates.push({
        kind: 'task',
        id: String(card._id),
        title: card.title,
        suggestedState: card.completedAt ? 'done' : 'moved',
        evidence: [{ kind: 'task', id: String(card._id), label: card.title }],
      });
    }
    const ts = now();
    const conversationId = `checkin_${args.userId}_${args.localDate.replaceAll('-', '')}`;
    const checkinId = await ctx.db.insert('albatrossDailyCheckins', {
      userId: args.userId,
      localDate: args.localDate,
      timezone: args.timezone,
      status: 'scheduled',
      candidateItems: candidates.slice(0, 60),
      conversationId,
      createdAt: ts,
      updatedAt: ts,
    });
    const notificationId = await ctx.db.insert(
      'albatrossNotifications',
      notificationPayload({
        userId: args.userId,
        type: 'daily_checkin',
        title: 'What did you actually get done today?',
        body: candidates.length
          ? `Albatross found ${candidates.length} things that may have moved. Confirm them or tell it what really happened.`
          : 'Tell Albatross what moved, what did not, and what should change tomorrow.',
        entityKind: 'checkin',
        entityId: String(checkinId),
        deepLink: `/?checkin=${String(checkinId)}`,
        dedupeKey: `daily-checkin:${args.localDate}`,
        scheduledFor: ts,
      }),
    );
    await ctx.db.insert('notificationDeliveries', {
      userId: args.userId,
      notificationId,
      channel: 'in_app',
      status: 'sent',
      attemptCount: 1,
      scheduledFor: ts,
      sentAt: ts,
      createdAt: ts,
      updatedAt: ts,
    });
    await ctx.db.patch(notificationId, { status: 'delivered', updatedAt: ts });
    return { checkin: await ctx.db.get(checkinId), notificationId, created: true };
  },
});

export const deliveryContext = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    checkinId: v.id('albatrossDailyCheckins'),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const checkin = await ctx.db.get(args.checkinId);
    if (!checkin || checkin.userId !== args.userId) return null;
    const notification = await ctx.db
      .query('albatrossNotifications')
      .withIndex('by_user_dedupe', (q) =>
        q.eq('userId', args.userId).eq('dedupeKey', `daily-checkin:${checkin.localDate}`),
      )
      .unique();
    const subscriptions = await ctx.db
      .query('webPushSubscriptions')
      .withIndex('by_user_status', (q) => q.eq('userId', args.userId).eq('status', 'active'))
      .collect();
    const deliveries = notification
      ? await ctx.db
          .query('notificationDeliveries')
          .withIndex('by_notification', (q) => q.eq('notificationId', notification._id))
          .collect()
      : [];
    return { checkin, notification, subscriptions, deliveries };
  },
});

export const latestUnansweredCheckin = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('albatrossDailyCheckins')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .order('desc')
      .take(3);
    return rows.find((row) => row.status === 'scheduled' || row.status === 'open') || null;
  },
});

export const recordDelivery = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    notificationId: v.id('albatrossNotifications'),
    channel: v.union(v.literal('web_push'), v.literal('email')),
    status: v.union(v.literal('sent'), v.literal('failed'), v.literal('suppressed')),
    providerId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = (
      await ctx.db
        .query('notificationDeliveries')
        .withIndex('by_notification', (q) => q.eq('notificationId', args.notificationId))
        .collect()
    ).find((row) => row.channel === args.channel);
    const ts = now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: args.status,
        attemptCount: existing.attemptCount + 1,
        providerId: args.providerId,
        error: args.error?.slice(0, 500),
        sentAt: args.status === 'sent' ? ts : existing.sentAt,
        updatedAt: ts,
      });
      return existing._id;
    }
    return ctx.db.insert('notificationDeliveries', {
      userId: args.userId,
      notificationId: args.notificationId,
      channel: args.channel,
      status: args.status,
      attemptCount: 1,
      providerId: args.providerId,
      error: args.error?.slice(0, 500),
      scheduledFor: ts,
      sentAt: args.status === 'sent' ? ts : undefined,
      createdAt: ts,
      updatedAt: ts,
    });
  },
});

export const expireSubscription = mutation({
  args: { internalSecret: v.optional(v.string()), endpoint: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('webPushSubscriptions')
      .withIndex('by_endpoint', (q) => q.eq('endpoint', args.endpoint))
      .unique();
    if (row) await ctx.db.patch(row._id, { status: 'expired', updatedAt: now() });
  },
});

export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) return;
    const targets = await ctx.runQuery(internal.albatrossNotifications.targets, {});
    await fanOutInternalPost(`${appUrl}/api/cron/albatross-notifications`, secret, targets, {
      label: 'albatross-notifications',
      concurrency: 4,
      timeoutMs: 60_000,
    });
  },
});

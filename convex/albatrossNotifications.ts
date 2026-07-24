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
    | 'event_suggestion'
    | 'mail_message'
    | 'brief_ready'
    | 'agent_error';
  title: string;
  body: string;
  entityKind?: 'checkin' | 'work' | 'project' | 'area' | 'approval' | 'suggestion' | 'thread';
  entityId?: string;
  deepLink: string;
  dedupeKey: string;
  scheduledFor: number;
}) {
  const ts = now();
  return { ...input, status: 'queued' as const, createdAt: ts, updatedAt: ts };
}

async function ensureDailyAlignmentNotifications(
  ctx: MutationCtx,
  input: {
    userId: string;
    checkinId: any;
    localDate: string;
    candidateCount: number;
  },
) {
  const ts = now();
  const prompts = [
    {
      kind: 'reflection' as const,
      title: 'What did you get done today?',
      body: input.candidateCount
        ? `Albatross found ${input.candidateCount} things that may have moved. Reply in your own words.`
        : 'Tell Albatross what moved, what did not, and what you learned.',
    },
    {
      kind: 'tomorrow' as const,
      title: 'What do you want to get done tomorrow?',
      body: 'Reply in your own words. Albatross will use this intent to shape your next brief and next actions.',
    },
  ];
  const notificationIds = [];
  for (const prompt of prompts) {
    const dedupeKey = `daily-checkin:${input.localDate}:${prompt.kind}`;
    let notification = await ctx.db
      .query('albatrossNotifications')
      .withIndex('by_user_dedupe', (q) => q.eq('userId', input.userId).eq('dedupeKey', dedupeKey))
      .unique();
    // Reuse the pre-alignment reflection notification when upgrading an
    // already-open check-in, instead of sending a duplicate.
    if (!notification && prompt.kind === 'reflection') {
      notification = await ctx.db
        .query('albatrossNotifications')
        .withIndex('by_user_dedupe', (q) =>
          q.eq('userId', input.userId).eq('dedupeKey', `daily-checkin:${input.localDate}`),
        )
        .unique();
    }
    if (!notification) {
      const notificationId = await ctx.db.insert(
        'albatrossNotifications',
        notificationPayload({
          userId: input.userId,
          type: 'daily_checkin',
          title: prompt.title,
          body: prompt.body,
          entityKind: 'checkin',
          entityId: String(input.checkinId),
          deepLink: `/?checkin=${String(input.checkinId)}&prompt=${prompt.kind}`,
          dedupeKey,
          scheduledFor: ts,
        }),
      );
      await ctx.db.insert('notificationDeliveries', {
        userId: input.userId,
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
      notification = await ctx.db.get(notificationId);
    }
    if (notification) notificationIds.push(notification._id);
  }
  return notificationIds;
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
        nativePushEnabled: true,
        newMailPushEnabled: true,
        eventSuggestionPushEnabled: true,
        morningBriefEnabled: true,
        emailFallbackEnabled: true,
        emailFallbackDelayMinutes: DEFAULT_EMAIL_DELAY,
        briefLocationEnabled: false,
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
    nativePushEnabled: v.optional(v.boolean()),
    newMailPushEnabled: v.optional(v.boolean()),
    eventSuggestionPushEnabled: v.optional(v.boolean()),
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
      nativePushEnabled: args.nativePushEnabled ?? existing?.nativePushEnabled ?? true,
      newMailPushEnabled: args.newMailPushEnabled ?? existing?.newMailPushEnabled ?? true,
      eventSuggestionPushEnabled:
        args.eventSuggestionPushEnabled ?? existing?.eventSuggestionPushEnabled ?? true,
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

export const mobilePreferences = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('albatrossNotificationPreferences')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .unique();
    return {
      nativePushEnabled: row?.nativePushEnabled ?? true,
      newMailPushEnabled: row?.newMailPushEnabled ?? true,
      eventSuggestionPushEnabled: row?.eventSuggestionPushEnabled ?? true,
      morningBriefEnabled: row?.morningBriefEnabled ?? true,
      eveningCheckinEnabled: row?.eveningCheckinEnabled ?? true,
      eveningCheckinLocalTime: row?.eveningCheckinLocalTime ?? DEFAULT_CHECKIN_TIME,
      inAppEnabled: row?.inAppEnabled ?? true,
      emailFallbackEnabled: row?.emailFallbackEnabled ?? true,
      emailFallbackDelayMinutes: row?.emailFallbackDelayMinutes ?? DEFAULT_EMAIL_DELAY,
      timezone: row?.timezone ?? DEFAULT_TZ,
      briefLocationEnabled: row?.briefLocationEnabled ?? false,
      briefLatitude: row?.briefLatitude,
      briefLongitude: row?.briefLongitude,
      briefLocationLabel: row?.briefLocationLabel,
      briefLocationAccuracy: row?.briefLocationAccuracy,
      briefLocationUpdatedAt: row?.briefLocationUpdatedAt,
    };
  },
});

export const saveMobilePreferences = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    nativePushEnabled: v.boolean(),
    newMailPushEnabled: v.boolean(),
    eventSuggestionPushEnabled: v.boolean(),
    morningBriefEnabled: v.optional(v.boolean()),
    eveningCheckinEnabled: v.boolean(),
    eveningCheckinLocalTime: v.string(),
    inAppEnabled: v.boolean(),
    emailFallbackEnabled: v.boolean(),
    emailFallbackDelayMinutes: v.number(),
    timezone: v.string(),
    briefLocationEnabled: v.optional(v.boolean()),
    briefLatitude: v.optional(v.number()),
    briefLongitude: v.optional(v.number()),
    briefLocationLabel: v.optional(v.string()),
    briefLocationAccuracy: v.optional(v.number()),
    briefLocationUpdatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await ctx.db
      .query('albatrossNotificationPreferences')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .unique();
    const ts = now();
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(args.eveningCheckinLocalTime)) {
      throw new Error('Time must be HH:MM.');
    }
    if (args.emailFallbackDelayMinutes < 15 || args.emailFallbackDelayMinutes > 1_440) {
      throw new Error('Fallback delay must be between 15 and 1440 minutes.');
    }
    if (
      args.briefLatitude !== undefined &&
      (!Number.isFinite(args.briefLatitude) || args.briefLatitude < -90 || args.briefLatitude > 90)
    ) {
      throw new Error('Invalid brief latitude.');
    }
    if (
      args.briefLongitude !== undefined &&
      (!Number.isFinite(args.briefLongitude) || args.briefLongitude < -180 || args.briefLongitude > 180)
    ) {
      throw new Error('Invalid brief longitude.');
    }
    if (
      args.briefLocationEnabled === true &&
      (args.briefLatitude === undefined || args.briefLongitude === undefined)
    ) {
      throw new Error('Brief location coordinates are required.');
    }
    const briefLocationEnabled = args.briefLocationEnabled ?? existing?.briefLocationEnabled ?? false;
    const mobile = {
      nativePushEnabled: args.nativePushEnabled,
      newMailPushEnabled: args.newMailPushEnabled,
      eventSuggestionPushEnabled: args.eventSuggestionPushEnabled,
      morningBriefEnabled: args.morningBriefEnabled ?? existing?.morningBriefEnabled ?? true,
      eveningCheckinEnabled: args.eveningCheckinEnabled,
      eveningCheckinLocalTime: args.eveningCheckinLocalTime,
      inAppEnabled: args.inAppEnabled,
      emailFallbackEnabled: args.emailFallbackEnabled,
      emailFallbackDelayMinutes: Math.round(args.emailFallbackDelayMinutes),
      timezone: args.timezone,
      briefLocationEnabled,
      briefLatitude: briefLocationEnabled ? (args.briefLatitude ?? existing?.briefLatitude) : undefined,
      briefLongitude: briefLocationEnabled ? (args.briefLongitude ?? existing?.briefLongitude) : undefined,
      briefLocationLabel: briefLocationEnabled
        ? (args.briefLocationLabel ?? existing?.briefLocationLabel)
        : undefined,
      briefLocationAccuracy: briefLocationEnabled
        ? (args.briefLocationAccuracy ?? existing?.briefLocationAccuracy)
        : undefined,
      briefLocationUpdatedAt: briefLocationEnabled
        ? (args.briefLocationUpdatedAt ?? existing?.briefLocationUpdatedAt)
        : undefined,
      updatedAt: ts,
    };
    if (existing) {
      await ctx.db.patch(existing._id, mobile);
      return existing._id;
    }
    return ctx.db.insert('albatrossNotificationPreferences', {
      userId: args.userId,
      ...mobile,
      webPushEnabled: false,
      createdAt: ts,
    });
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

export const upsertMobileDevice = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    platform: v.literal('ios'),
    token: v.string(),
    deviceId: v.string(),
    environment: v.union(v.literal('development'), v.literal('production')),
    appVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const device = {
      userId: args.userId,
      platform: args.platform,
      token: args.token,
      deviceId: args.deviceId,
      environment: args.environment,
      appVersion: args.appVersion,
    };
    const [byDevice, byToken] = await Promise.all([
      ctx.db
        .query('mobilePushDevices')
        .withIndex('by_user_device', (q) =>
          q.eq('userId', args.userId).eq('platform', args.platform).eq('deviceId', args.deviceId),
        )
        .unique(),
      ctx.db
        .query('mobilePushDevices')
        .withIndex('by_token', (q) => q.eq('token', args.token))
        .unique(),
    ]);
    const ts = now();

    // A token can move between signed-in users on a shared phone. Reuse the
    // token row and remove this install's obsolete row so the previous user
    // can never receive the new user's notifications (or vice versa).
    if (byToken) {
      if (byDevice && byDevice._id !== byToken._id) await ctx.db.delete(byDevice._id);
      await ctx.db.patch(byToken._id, {
        ...device,
        status: 'active',
        updatedAt: ts,
      });
      return byToken._id;
    }
    if (byDevice) {
      await ctx.db.patch(byDevice._id, {
        ...device,
        status: 'active',
        updatedAt: ts,
      });
      return byDevice._id;
    }
    return ctx.db.insert('mobilePushDevices', {
      ...device,
      status: 'active',
      createdAt: ts,
      updatedAt: ts,
    });
  },
});

export const revokeMobileDevice = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    token: v.optional(v.string()),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('mobilePushDevices')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    const matches = rows.filter(
      (row) => (args.token && row.token === args.token) || (args.deviceId && row.deviceId === args.deviceId),
    );
    const ts = now();
    for (const row of matches) await ctx.db.patch(row._id, { status: 'revoked', updatedAt: ts });
    return { revoked: matches.length };
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

export const queueSuggestionNotification = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    suggestionId: v.id('suggestions'),
    title: v.string(),
    body: v.string(),
    accountId: v.string(),
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const suggestion = await ctx.db.get(args.suggestionId);
    if (!suggestion || suggestion.userId !== args.userId) throw new Error('Suggestion not found.');
    const dedupeKey = `event-suggestion:${String(args.suggestionId)}`;
    const existing = await ctx.db
      .query('albatrossNotifications')
      .withIndex('by_user_dedupe', (q) => q.eq('userId', args.userId).eq('dedupeKey', dedupeKey))
      .unique();
    if (existing) return { notificationId: existing._id, created: false };
    const ts = now();
    const query = new URLSearchParams({
      account: args.accountId,
      thread: args.threadId,
      suggestion: String(args.suggestionId),
    });
    const notificationId = await ctx.db.insert(
      'albatrossNotifications',
      notificationPayload({
        userId: args.userId,
        type: 'event_suggestion',
        title: args.title.slice(0, 180),
        body: args.body.slice(0, 1_000),
        entityKind: 'suggestion',
        entityId: String(args.suggestionId),
        deepLink: `/mail/thread?${query.toString()}`,
        dedupeKey,
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
    return { notificationId, created: true };
  },
});

export const queueMailNotification = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    threadId: v.string(),
    messageId: v.string(),
    sender: v.string(),
    subject: v.string(),
    snippet: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const dedupeKey = `mail-message:${args.accountId}:${args.messageId}`;
    const existing = await ctx.db
      .query('albatrossNotifications')
      .withIndex('by_user_dedupe', (q) => q.eq('userId', args.userId).eq('dedupeKey', dedupeKey))
      .unique();
    if (existing) return { notificationId: existing._id, created: false };
    const ts = now();
    const query = new URLSearchParams({
      account: args.accountId,
      thread: args.threadId,
      message: args.messageId,
    });
    const notificationId = await ctx.db.insert(
      'albatrossNotifications',
      notificationPayload({
        userId: args.userId,
        type: 'mail_message',
        title: (args.sender.trim() || 'New email').slice(0, 180),
        body: (args.subject.trim() || args.snippet.trim() || 'New message').slice(0, 1_000),
        entityKind: 'thread',
        entityId: args.threadId,
        deepLink: `/mail/thread?${query.toString()}`,
        dedupeKey,
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
    return { notificationId, created: true };
  },
});

export const queueBriefReady = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    reportId: v.string(),
    localDate: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const preference = await ctx.db
      .query('albatrossNotificationPreferences')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .unique();
    if (preference?.morningBriefEnabled === false) {
      return { notificationId: null, created: false, skipped: 'disabled' as const };
    }
    const dedupeKey = `brief-ready:${args.localDate}`;
    const existing = await ctx.db
      .query('albatrossNotifications')
      .withIndex('by_user_dedupe', (q) => q.eq('userId', args.userId).eq('dedupeKey', dedupeKey))
      .unique();
    if (existing) return { notificationId: existing._id, created: false };
    const ts = now();
    const notificationId = await ctx.db.insert(
      'albatrossNotifications',
      notificationPayload({
        userId: args.userId,
        type: 'brief_ready',
        title: String(args.title || 'Your Daily Brief is ready')
          .trim()
          .slice(0, 180),
        body: 'Weather, today’s pressure, and your stated intent for tomorrow are assembled.',
        deepLink: `/brief?id=${encodeURIComponent(args.reportId)}`,
        dedupeKey,
        scheduledFor: ts,
      }),
    );
    if (preference?.inAppEnabled !== false) {
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
    }
    await ctx.db.patch(notificationId, { status: 'delivered', updatedAt: ts });
    return { notificationId, created: true };
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
    promptKind: v.optional(v.union(v.literal('reflection'), v.literal('tomorrow'))),
    responseText: v.string(),
    completed: v.optional(v.array(v.object({ kind: v.string(), id: v.string() }))),
  },
  handler: async (ctx, args) => {
    const userId = await notificationCallerUserId(ctx, args);
    const row = await ctx.db.get(args.checkinId);
    if (!row || row.userId !== userId) throw new Error('Check-in not found.');
    const promptKind = args.promptKind ?? 'reflection';
    const responseText = args.responseText.trim().slice(0, 10_000);
    if (!responseText && !args.completed?.length) throw new Error('Tell Albatross what happened.');
    const completed = new Set((args.completed || []).map((entry) => `${entry.kind}:${entry.id}`));
    const changes: Array<{ kind: string; id: string; previousState?: string; nextState?: string }> = [];
    const ts = now();
    for (const item of promptKind === 'reflection' ? row.candidateItems : []) {
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
    const reflectionText = promptKind === 'reflection' ? responseText : row.responseText;
    const tomorrowIntentText = promptKind === 'tomorrow' ? responseText : row.tomorrowIntentText;
    const isComplete = Boolean(reflectionText?.trim() && tomorrowIntentText?.trim());
    await ctx.db.patch(row._id, {
      status: isComplete ? 'answered' : 'open',
      ...(promptKind === 'reflection'
        ? { responseText, reconciledChanges: changes, reflectionAnsweredAt: ts }
        : { tomorrowIntentText, tomorrowIntentAnsweredAt: ts }),
      ...(isComplete ? { answeredAt: ts } : {}),
      updatedAt: ts,
    });
    const notifications = await ctx.db
      .query('albatrossNotifications')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .order('desc')
      .take(20);
    const matchingNotification = notifications.find((notification) => {
      if (notification.entityId !== String(row._id)) return false;
      if (promptKind === 'tomorrow') return /[?&]prompt=tomorrow\b/.test(notification.deepLink);
      return !/[?&]prompt=tomorrow\b/.test(notification.deepLink);
    });
    if (matchingNotification)
      await ctx.db.patch(matchingNotification._id, {
        status: 'acted',
        actedAt: ts,
        readAt: matchingNotification.readAt ?? ts,
        updatedAt: ts,
      });
    return { changes, status: isComplete ? 'answered' : 'open' };
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

export const mobileCurrentCheckin = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('albatrossDailyCheckins')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
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
        nativePushEnabled: preference?.nativePushEnabled ?? true,
        newMailPushEnabled: preference?.newMailPushEnabled ?? true,
        eventSuggestionPushEnabled: preference?.eventSuggestionPushEnabled ?? true,
        morningBriefEnabled: preference?.morningBriefEnabled ?? true,
        emailFallbackEnabled: preference?.emailFallbackEnabled ?? true,
        emailFallbackDelayMinutes: preference?.emailFallbackDelayMinutes ?? DEFAULT_EMAIL_DELAY,
      });
    }
    return out;
  },
});

export const deliveryTimezone = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const preference = await ctx.db
      .query('albatrossNotificationPreferences')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .unique();
    if (preference?.timezone) return preference.timezone;
    const calendars = await ctx.db
      .query('calendars')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    return (
      calendars.find((calendar) => calendar.isPrimary && calendar.timezone)?.timezone ||
      calendars.find((calendar) => calendar.timezone)?.timezone ||
      DEFAULT_TZ
    );
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
    if (existing) {
      const notificationIds = await ensureDailyAlignmentNotifications(ctx, {
        userId: args.userId,
        checkinId: existing._id,
        localDate: existing.localDate,
        candidateCount: existing.candidateItems.length,
      });
      if (existing.status === 'answered' && !existing.tomorrowIntentText?.trim()) {
        await ctx.db.patch(existing._id, { status: 'open', updatedAt: now() });
      }
      return {
        checkin: await ctx.db.get(existing._id),
        notificationId: notificationIds[0],
        notificationIds,
        created: false,
      };
    }
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
    const notificationIds = await ensureDailyAlignmentNotifications(ctx, {
      userId: args.userId,
      checkinId,
      localDate: args.localDate,
      candidateCount: candidates.length,
    });
    return {
      checkin: await ctx.db.get(checkinId),
      notificationId: notificationIds[0],
      notificationIds,
      created: true,
    };
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
    let notification = await ctx.db
      .query('albatrossNotifications')
      .withIndex('by_user_dedupe', (q) =>
        q.eq('userId', args.userId).eq('dedupeKey', `daily-checkin:${checkin.localDate}:reflection`),
      )
      .unique();
    notification ??= await ctx.db
      .query('albatrossNotifications')
      .withIndex('by_user_dedupe', (q) =>
        q.eq('userId', args.userId).eq('dedupeKey', `daily-checkin:${checkin.localDate}`),
      )
      .unique();
    const subscriptions = await ctx.db
      .query('webPushSubscriptions')
      .withIndex('by_user_status', (q) => q.eq('userId', args.userId).eq('status', 'active'))
      .collect();
    const mobileDevices = await ctx.db
      .query('mobilePushDevices')
      .withIndex('by_user_status', (q) => q.eq('userId', args.userId).eq('status', 'active'))
      .collect();
    const deliveries = notification
      ? await ctx.db
          .query('notificationDeliveries')
          .withIndex('by_notification', (q) => q.eq('notificationId', notification._id))
          .collect()
      : [];
    const preference = await ctx.db
      .query('albatrossNotificationPreferences')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .unique();
    return { checkin, notification, subscriptions, mobileDevices, deliveries, preference };
  },
});

export const nativeDeliveryContext = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    notificationId: v.id('albatrossNotifications'),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.userId !== args.userId) return null;
    const mobileDevices = await ctx.db
      .query('mobilePushDevices')
      .withIndex('by_user_status', (q) => q.eq('userId', args.userId).eq('status', 'active'))
      .collect();
    const deliveries = await ctx.db
      .query('notificationDeliveries')
      .withIndex('by_notification', (q) => q.eq('notificationId', args.notificationId))
      .collect();
    const nativeDeviceDeliveries = await ctx.db
      .query('nativePushDeliveries')
      .withIndex('by_notification', (q) => q.eq('notificationId', args.notificationId))
      .collect();
    const preference = await ctx.db
      .query('albatrossNotificationPreferences')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .unique();
    return { notification, mobileDevices, deliveries, nativeDeviceDeliveries, preference };
  },
});

export const notificationResponseContext = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    notificationId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const notificationId = ctx.db.normalizeId('albatrossNotifications', args.notificationId);
    if (!notificationId) return null;
    const notification = await ctx.db.get(notificationId);
    return notification?.userId === args.userId ? notification : null;
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
    channel: v.union(v.literal('web_push'), v.literal('native_push'), v.literal('email')),
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

export const updateMobileDeviceDelivery = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    token: v.string(),
    status: v.union(v.literal('delivered'), v.literal('expired')),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('mobilePushDevices')
      .withIndex('by_token', (q) => q.eq('token', args.token))
      .unique();
    if (!row) return;
    const ts = now();
    await ctx.db.patch(row._id, {
      ...(args.status === 'delivered' ? { lastDeliveredAt: ts } : { status: 'expired' as const }),
      updatedAt: ts,
    });
  },
});

export const recordNativeDeviceDelivery = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    notificationId: v.id('albatrossNotifications'),
    token: v.string(),
    status: v.union(v.literal('delivered'), v.literal('expired'), v.literal('failed')),
    providerId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.userId !== args.userId) {
      throw new Error('Notification not found.');
    }
    const device = await ctx.db
      .query('mobilePushDevices')
      .withIndex('by_token', (q) => q.eq('token', args.token))
      .unique();
    if (!device || device.userId !== args.userId) throw new Error('Mobile device not found.');

    const ts = now();
    const existing = await ctx.db
      .query('nativePushDeliveries')
      .withIndex('by_notification_token', (q) =>
        q.eq('notificationId', args.notificationId).eq('token', args.token),
      )
      .unique();
    const receipt = {
      status: args.status,
      attemptCount: (existing?.attemptCount ?? 0) + 1,
      providerId: args.providerId,
      error: args.error?.slice(0, 500),
      updatedAt: ts,
    };
    if (existing) await ctx.db.patch(existing._id, receipt);
    else {
      await ctx.db.insert('nativePushDeliveries', {
        userId: args.userId,
        notificationId: args.notificationId,
        token: args.token,
        ...receipt,
        createdAt: ts,
      });
    }
    if (args.status === 'delivered') {
      await ctx.db.patch(device._id, { lastDeliveredAt: ts, updatedAt: ts });
    } else if (args.status === 'expired') {
      await ctx.db.patch(device._id, { status: 'expired', updatedAt: ts });
    }
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

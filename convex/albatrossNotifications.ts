import { v } from 'convex/values';
import { matchReflectionCandidates } from '../lib/albatross/daily-intent';
import { wakeLine } from '../lib/albatross/horizon';
import { checkinRetryDelayMs } from '../lib/albatross/retry';
import { briefReadyFallbackBody } from '../lib/notifications/brief-ready-copy';
import { digestCopy, mailPushSettingsFromRow, normalizeVipSenders } from '../lib/notifications/mail-push';
import { truncateText } from '../lib/shared/text';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server';
import { internalAction, internalMutation, internalQuery, mutation, query } from './_generated/server';
import { fanOutInternalPost, now, requireInternalSecret } from './lib';
import { completeWorkInMutation } from './workCompletion';

const DEFAULT_TZ = 'UTC';
const DEFAULT_CHECKIN_TIME = '19:00';
const DEFAULT_EMAIL_DELAY = 90;
const CHECKIN_BACKGROUND_LEASE_MS = 10 * 60_000;
const CHECKIN_BACKGROUND_MAX_ATTEMPTS = 6;

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
    | 'work_wake'
    | 'approval'
    | 'completion_suggestion'
    | 'event_suggestion'
    | 'mail_message'
    | 'urgent_mail'
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

async function ensureInAppDelivery(
  ctx: MutationCtx,
  input: {
    userId: string;
    notificationId: Id<'albatrossNotifications'>;
    enabled: boolean;
    timestamp: number;
  },
) {
  if (!input.enabled) return false;
  const deliveries = await ctx.db
    .query('notificationDeliveries')
    .withIndex('by_notification', (q) => q.eq('notificationId', input.notificationId))
    .collect();
  if (deliveries.some((delivery) => delivery.channel === 'in_app')) return false;
  await ctx.db.insert('notificationDeliveries', {
    userId: input.userId,
    notificationId: input.notificationId,
    channel: 'in_app',
    status: 'sent',
    attemptCount: 1,
    scheduledFor: input.timestamp,
    sentAt: input.timestamp,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  });
  const notification = await ctx.db.get(input.notificationId);
  if (notification?.status === 'queued') {
    await ctx.db.patch(input.notificationId, {
      status: 'delivered',
      updatedAt: input.timestamp,
    });
  }
  return true;
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
  const preference = await ctx.db
    .query('albatrossNotificationPreferences')
    .withIndex('by_user', (q) => q.eq('userId', input.userId))
    .unique();
  const inAppEnabled = preference?.inAppEnabled !== false;
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
  const openNotificationIds = [];
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
      notification = await ctx.db.get(notificationId);
    }
    if (notification) {
      await ensureInAppDelivery(ctx, {
        userId: input.userId,
        notificationId: notification._id,
        enabled: inAppEnabled,
        timestamp: ts,
      });
      notificationIds.push(notification._id);
      // The check-in stays due all evening (WRK-15). A prompt the user already
      // read or answered is not pushed again.
      const current = await ctx.db.get(notification._id);
      if (current && (current.status === 'queued' || current.status === 'delivered'))
        openNotificationIds.push(notification._id);
    }
  }
  return { notificationIds, openNotificationIds };
}

async function applyCompletedCandidates(
  ctx: MutationCtx,
  row: Doc<'albatrossDailyCheckins'>,
  completed: ReadonlySet<string>,
  ts: number,
) {
  const changes: Array<{ kind: string; id: string; previousState?: string; nextState?: string }> = [];
  for (const item of row.candidateItems) {
    if (!completed.has(`${item.kind}:${item.id}`)) continue;
    if (item.kind === 'work') {
      const workId = ctx.db.normalizeId('albatrossIntents', item.id);
      if (workId) {
        const work = await ctx.db.get(workId);
        if (work?.userId === row.userId && work.workState !== 'done') {
          // The shared terminal transition retires cards, clears conductor
          // flags, and records the completion (WRK-1, WRK-9).
          await completeWorkInMutation(ctx, work, ts);
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
        if (project?.userId === row.userId && project.status !== 'done') {
          await ctx.db.patch(projectId, { status: 'done', completedAt: ts, updatedAt: ts });
          changes.push({ kind: 'project', id: item.id, previousState: project.status, nextState: 'done' });
        }
      }
    }
    if (item.kind === 'task') {
      const cardId = ctx.db.normalizeId('cards', item.id);
      if (cardId) {
        const card = await ctx.db.get(cardId);
        if (card?.userId === row.userId && !card.completedAt) {
          await ctx.db.patch(cardId, { completedAt: ts, updatedAt: ts });
          changes.push({ kind: 'task', id: item.id, previousState: 'open', nextState: 'done' });
        }
      }
    }
  }
  return changes;
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
      urgentMailPushEnabled: row?.urgentMailPushEnabled ?? true,
      eventSuggestionPushEnabled: row?.eventSuggestionPushEnabled ?? true,
      morningBriefEnabled: row?.morningBriefEnabled ?? true,
      // AutoFill is on by default because it does nothing until the user also
      // enables Albatross as a credential provider in Settings. Cleanup is off
      // by default because it deletes mail.
      oneTimeCodeAutofillEnabled: row?.oneTimeCodeAutofillEnabled ?? true,
      oneTimeCodeCleanupEnabled: row?.oneTimeCodeCleanupEnabled ?? false,
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
    urgentMailPushEnabled: v.optional(v.boolean()),
    eventSuggestionPushEnabled: v.boolean(),
    morningBriefEnabled: v.optional(v.boolean()),
    oneTimeCodeAutofillEnabled: v.optional(v.boolean()),
    oneTimeCodeCleanupEnabled: v.optional(v.boolean()),
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
    const briefLocationEnabled = args.briefLocationEnabled ?? existing?.briefLocationEnabled ?? false;
    const briefLatitude = args.briefLatitude ?? existing?.briefLatitude;
    const briefLongitude = args.briefLongitude ?? existing?.briefLongitude;
    if (briefLocationEnabled && (briefLatitude === undefined || briefLongitude === undefined)) {
      throw new Error('Brief location coordinates are required.');
    }
    const mobile = {
      nativePushEnabled: args.nativePushEnabled,
      newMailPushEnabled: args.newMailPushEnabled,
      urgentMailPushEnabled: args.urgentMailPushEnabled ?? existing?.urgentMailPushEnabled ?? true,
      eventSuggestionPushEnabled: args.eventSuggestionPushEnabled,
      morningBriefEnabled: args.morningBriefEnabled ?? existing?.morningBriefEnabled ?? true,
      oneTimeCodeAutofillEnabled:
        args.oneTimeCodeAutofillEnabled ?? existing?.oneTimeCodeAutofillEnabled ?? true,
      oneTimeCodeCleanupEnabled:
        args.oneTimeCodeCleanupEnabled ?? existing?.oneTimeCodeCleanupEnabled ?? false,
      eveningCheckinEnabled: args.eveningCheckinEnabled,
      eveningCheckinLocalTime: args.eveningCheckinLocalTime,
      inAppEnabled: args.inAppEnabled,
      emailFallbackEnabled: args.emailFallbackEnabled,
      emailFallbackDelayMinutes: Math.round(args.emailFallbackDelayMinutes),
      timezone: args.timezone,
      briefLocationEnabled,
      briefLatitude: briefLocationEnabled ? briefLatitude : undefined,
      briefLongitude: briefLocationEnabled ? briefLongitude : undefined,
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
    platform: v.union(v.literal('ios'), v.literal('macos')),
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

const notificationTypeValidator = v.union(
  v.literal('daily_checkin'),
  v.literal('work_question'),
  v.literal('work_wake'),
  v.literal('approval'),
  v.literal('completion_suggestion'),
  v.literal('event_suggestion'),
  v.literal('mail_message'),
  v.literal('urgent_mail'),
  v.literal('brief_ready'),
  v.literal('agent_error'),
);

export const liveCenter = query({
  args: {
    limit: v.optional(v.number()),
    // Read only these types, each from the type index. Mail rows exist for
    // push delivery and must not take the bell's slots (WRK-3).
    types: v.optional(v.array(notificationTypeValidator)),
  },
  handler: async (ctx, args) => {
    const userId = await authenticatedUserId(ctx);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
    const preference = await ctx.db
      .query('albatrossNotificationPreferences')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .unique();
    // The in-app center switch hides and stops counting every row (UI-5).
    if (preference?.inAppEnabled === false) return { unread: 0, notifications: [] };
    const rows = args.types
      ? (
          await Promise.all(
            [...new Set(args.types)].map((type) =>
              ctx.db
                .query('albatrossNotifications')
                .withIndex('by_user_type_created', (q) => q.eq('userId', userId).eq('type', type))
                .order('desc')
                .take(limit),
            ),
          )
        )
          .flat()
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit)
      : await ctx.db
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
        title: truncateText(args.title, 180),
        body: truncateText(args.body, 1_000),
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
        title: truncateText(args.sender.trim() || 'New email', 180),
        body: truncateText(args.subject.trim() || args.snippet.trim() || 'New message', 1_000),
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

// Urgent mail dedupes on its own key rather than sharing 'mail-message:' with
// the ordinary notifier. If the two collided, whichever fired first would
// suppress the other — and a routine new-mail alert silently swallowing the
// urgent one is the wrong way round.
export const queueUrgentMailNotification = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    threadId: v.string(),
    messageId: v.string(),
    sender: v.string(),
    subject: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const dedupeKey = `urgent-mail:${args.accountId}:${args.messageId}`;
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
      urgent: '1',
    });
    const subject = args.subject.trim();
    const reason = args.reason.trim();
    const notificationId = await ctx.db.insert(
      'albatrossNotifications',
      notificationPayload({
        userId: args.userId,
        type: 'urgent_mail',
        title: truncateText(args.sender.trim() || 'Urgent email', 180),
        // The reason is why this one interrupted, so it earns its place in the
        // body rather than being hidden behind a tap.
        body: truncateText([subject, reason].filter(Boolean).join(' — '), 1_000) || 'Needs your attention',
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
    // The first sentences of the lede (brief round 2026-09-22). Falls back to
    // the fixed line when the edition has no prose.
    body: v.optional(v.string()),
    // The parts the edition holds. The fallback line names only these.
    parts: v.optional(
      v.object({
        weather: v.optional(v.boolean()),
        events: v.optional(v.number()),
        tasks: v.optional(v.number()),
        intent: v.optional(v.boolean()),
      }),
    ),
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
    const ts = now();
    const inAppEnabled = preference?.inAppEnabled !== false;
    const dedupeKey = `brief-ready:${args.localDate}`;
    const existing = await ctx.db
      .query('albatrossNotifications')
      .withIndex('by_user_dedupe', (q) => q.eq('userId', args.userId).eq('dedupeKey', dedupeKey))
      .unique();
    if (existing) {
      await ensureInAppDelivery(ctx, {
        userId: args.userId,
        notificationId: existing._id,
        enabled: inAppEnabled,
        timestamp: ts,
      });
      return { notificationId: existing._id, created: false };
    }
    const notificationId = await ctx.db.insert(
      'albatrossNotifications',
      notificationPayload({
        userId: args.userId,
        type: 'brief_ready',
        title: truncateText(String(args.title || 'Your Daily Brief is ready').trim(), 180),
        body: truncateText(String(args.body || '').trim(), 180) || briefReadyFallbackBody(args.parts),
        deepLink: `/brief?id=${encodeURIComponent(args.reportId)}`,
        dedupeKey,
        scheduledFor: ts,
      }),
    );
    await ensureInAppDelivery(ctx, {
      userId: args.userId,
      notificationId,
      enabled: inAppEnabled,
      timestamp: ts,
    });
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
    // A delayed read from an open tab must not resurrect a dismissed/resolved
    // notification. Repeated reads also preserve the first read timestamp.
    if (args.status === 'read' && !['queued', 'delivered'].includes(row.status)) return;
    if (row.status === args.status) return;
    const ts = now();
    await ctx.db.patch(args.notificationId, {
      status: args.status,
      updatedAt: ts,
      ...(args.status === 'read' ? { readAt: row.readAt ?? ts } : {}),
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
    const responseText = truncateText(args.responseText.trim(), 10_000);
    if (!responseText && !args.completed?.length) throw new Error('Tell Albatross what happened.');
    const inferredCompleted =
      promptKind === 'reflection' ? matchReflectionCandidates(responseText, row.candidateItems) : [];
    const completed = new Set([
      ...(args.completed || []).map((entry) => `${entry.kind}:${entry.id}`),
      ...inferredCompleted.map((entry) => `${entry.kind}:${entry.id}`),
    ]);
    const ts = now();
    const changes =
      promptKind === 'reflection' ? await applyCompletedCandidates(ctx, row, completed, ts) : [];
    const reflectionText = promptKind === 'reflection' ? responseText || row.responseText : row.responseText;
    const tomorrowIntentText =
      promptKind === 'tomorrow' ? responseText || row.tomorrowIntentText : row.tomorrowIntentText;
    const isComplete = Boolean(reflectionText?.trim() && tomorrowIntentText?.trim());
    const reflectionShouldReconcile = Boolean(
      responseText &&
        (responseText !== row.responseText?.trim() ||
          row.reflectionReconcileStatus === 'failed' ||
          !row.reflectionReconcileStatus),
    );
    const tomorrowShouldPlan = Boolean(
      responseText &&
        (responseText !== row.tomorrowIntentText?.trim() ||
          row.tomorrowPlanStatus === 'failed' ||
          !row.tomorrowPlanStatus),
    );
    await ctx.db.patch(row._id, {
      status: isComplete ? 'answered' : 'open',
      ...(promptKind === 'reflection'
        ? {
            responseText: reflectionText,
            reconciledChanges: [...(row.reconciledChanges ?? []).slice(-120), ...changes].slice(-120),
            reflectionAnsweredAt: ts,
            ...(reflectionShouldReconcile
              ? {
                  reflectionReconcileStatus: 'pending' as const,
                  reflectionReconcileAttempts: 0,
                  reflectionReconcileClaimedAt: undefined,
                  reflectionReconcileNextAt: ts,
                  reflectionReconcileError: undefined,
                }
              : !row.reflectionReconcileStatus
                ? { reflectionReconcileStatus: 'ready' as const }
                : {}),
          }
        : {
            tomorrowIntentText,
            tomorrowIntentAnsweredAt: ts,
            ...(tomorrowShouldPlan
              ? {
                  tomorrowPlanStatus: 'pending' as const,
                  tomorrowPlanAttempts: 0,
                  tomorrowPlanClaimedAt: undefined,
                  tomorrowPlanNextAt: ts,
                  tomorrowPlanError: undefined,
                }
              : {}),
          }),
      ...(isComplete ? { answeredAt: ts } : {}),
      updatedAt: ts,
    });
    const notificationDedupeKey =
      promptKind === 'tomorrow'
        ? `daily-checkin:${row.localDate}:tomorrow`
        : `daily-checkin:${row.localDate}:reflection`;
    let matchingNotification = await ctx.db
      .query('albatrossNotifications')
      .withIndex('by_user_dedupe', (q) => q.eq('userId', userId).eq('dedupeKey', notificationDedupeKey))
      .unique();
    if (!matchingNotification && promptKind === 'reflection') {
      matchingNotification = await ctx.db
        .query('albatrossNotifications')
        .withIndex('by_user_dedupe', (q) =>
          q.eq('userId', userId).eq('dedupeKey', `daily-checkin:${row.localDate}`),
        )
        .unique();
    }
    if (matchingNotification)
      await ctx.db.patch(matchingNotification._id, {
        status: 'acted',
        actedAt: ts,
        readAt: matchingNotification.readAt ?? ts,
        updatedAt: ts,
      });
    return {
      changes,
      matchedByReflection: inferredCompleted.map((entry) => ({ kind: entry.kind, id: entry.id })),
      status: isComplete ? 'answered' : 'open',
      promptKind,
      ...(promptKind === 'reflection'
        ? {
            reflectionReconcileStatus: reflectionShouldReconcile
              ? 'pending'
              : row.reflectionReconcileStatus || 'ready',
          }
        : {
            tomorrowPlanStatus: tomorrowShouldPlan ? 'pending' : row.tomorrowPlanStatus || 'pending',
          }),
    };
  },
});

async function queuedCheckins(ctx: QueryCtx, kind: 'reflection' | 'tomorrow', limit: number) {
  const ts = now();
  const index = kind === 'reflection' ? 'by_reflection_reconcile' : 'by_tomorrow_plan';
  const statusField = kind === 'reflection' ? 'reflectionReconcileStatus' : 'tomorrowPlanStatus';
  const nextField = kind === 'reflection' ? 'reflectionReconcileNextAt' : 'tomorrowPlanNextAt';
  const queuedStatuses = ['pending', 'failed'] as const;
  const rows: Doc<'albatrossDailyCheckins'>[] = [];
  for (const status of queuedStatuses) {
    const batch = await ctx.db
      .query('albatrossDailyCheckins')
      .withIndex(index as any, (q: any) => q.eq(statusField, status).lte(nextField, ts))
      .take(limit);
    rows.push(...batch);
  }
  const processingStatus = kind === 'reflection' ? 'processing' : 'planning';
  const stale = await ctx.db
    .query('albatrossDailyCheckins')
    .withIndex(index as any, (q: any) => q.eq(statusField, processingStatus).lte(nextField, ts))
    .take(limit);
  rows.push(...stale);
  return [...new Map(rows.map((row) => [String(row._id), row] as const)).values()]
    .filter((row) =>
      kind === 'reflection'
        ? Boolean(row.responseText?.trim()) &&
          (row.reflectionReconcileAttempts ?? 0) < CHECKIN_BACKGROUND_MAX_ATTEMPTS
        : Boolean(row.tomorrowIntentText?.trim()) &&
          (row.tomorrowPlanAttempts ?? 0) < CHECKIN_BACKGROUND_MAX_ATTEMPTS,
    )
    .sort((a, b) => {
      const aNext = kind === 'reflection' ? a.reflectionReconcileNextAt : a.tomorrowPlanNextAt;
      const bNext = kind === 'reflection' ? b.reflectionReconcileNextAt : b.tomorrowPlanNextAt;
      return Number(aNext || 0) - Number(bNext || 0) || a.createdAt - b.createdAt;
    })
    .slice(0, limit);
}

export const reflectionReconcileCandidates = internalQuery({
  args: {},
  handler: (ctx) => queuedCheckins(ctx, 'reflection', 6),
});

export const tomorrowPlanCandidates = internalQuery({
  args: {},
  handler: (ctx) => queuedCheckins(ctx, 'tomorrow', 4),
});

export const beginReflectionReconcile = internalMutation({
  args: { checkinId: v.id('albatrossDailyCheckins') },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.checkinId);
    if (!row?.responseText?.trim()) return null;
    const ts = now();
    if (
      !['pending', 'failed', 'processing'].includes(row.reflectionReconcileStatus || '') ||
      (row.reflectionReconcileNextAt ?? Number.POSITIVE_INFINITY) > ts ||
      (row.reflectionReconcileAttempts ?? 0) >= CHECKIN_BACKGROUND_MAX_ATTEMPTS
    ) {
      return null;
    }
    const attempts = (row.reflectionReconcileAttempts ?? 0) + 1;
    await ctx.db.patch(row._id, {
      reflectionReconcileStatus: 'processing',
      reflectionReconcileAttempts: attempts,
      reflectionReconcileClaimedAt: ts,
      reflectionReconcileNextAt: ts + CHECKIN_BACKGROUND_LEASE_MS,
      reflectionReconcileError: undefined,
      updatedAt: ts,
    });
    return {
      userId: row.userId,
      checkinId: String(row._id),
      responseText: row.responseText,
      candidateItems: row.candidateItems,
      attempts,
    };
  },
});

export const beginTomorrowPlan = internalMutation({
  args: { checkinId: v.id('albatrossDailyCheckins') },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.checkinId);
    if (!row?.tomorrowIntentText?.trim()) return null;
    const ts = now();
    if (
      !['pending', 'failed', 'planning'].includes(row.tomorrowPlanStatus || '') ||
      (row.tomorrowPlanNextAt ?? Number.POSITIVE_INFINITY) > ts ||
      (row.tomorrowPlanAttempts ?? 0) >= CHECKIN_BACKGROUND_MAX_ATTEMPTS
    ) {
      return null;
    }
    const attempts = (row.tomorrowPlanAttempts ?? 0) + 1;
    await ctx.db.patch(row._id, {
      tomorrowPlanStatus: 'planning',
      tomorrowPlanAttempts: attempts,
      tomorrowPlanClaimedAt: ts,
      tomorrowPlanNextAt: ts + CHECKIN_BACKGROUND_LEASE_MS,
      tomorrowPlanError: undefined,
      updatedAt: ts,
    });
    return {
      userId: row.userId,
      checkinId: String(row._id),
      tomorrowIntentText: row.tomorrowIntentText,
      timezone: row.timezone,
      attempts,
    };
  },
});

export const completeReflectionReconcile = mutation({
  args: {
    ...notificationCallerArgs,
    checkinId: v.id('albatrossDailyCheckins'),
    completed: v.array(v.object({ kind: v.string(), id: v.string() })),
  },
  handler: async (ctx, args) => {
    const userId = await notificationCallerUserId(ctx, args);
    const row = await ctx.db.get(args.checkinId);
    if (!row || row.userId !== userId) throw new Error('Check-in not found.');
    if (row.reflectionReconcileStatus !== 'processing') return { applied: 0, stale: true };
    const completed = new Set(args.completed.slice(0, 60).map((entry) => `${entry.kind}:${entry.id}`));
    const ts = now();
    const changes = await applyCompletedCandidates(ctx, row, completed, ts);
    await ctx.db.patch(row._id, {
      reconciledChanges: [...(row.reconciledChanges ?? []), ...changes].slice(-120),
      reflectionReconcileStatus: 'ready',
      reflectionReconcileClaimedAt: undefined,
      reflectionReconcileNextAt: undefined,
      reflectionReconcileError: undefined,
      updatedAt: ts,
    });
    return { applied: changes.length, stale: false };
  },
});

export const failReflectionReconcile = mutation({
  args: {
    ...notificationCallerArgs,
    checkinId: v.id('albatrossDailyCheckins'),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await notificationCallerUserId(ctx, args);
    const row = await ctx.db.get(args.checkinId);
    if (!row || row.userId !== userId) throw new Error('Check-in not found.');
    if (row.reflectionReconcileStatus !== 'processing') return { retrying: false, stale: true };
    const ts = now();
    const attempts = row.reflectionReconcileAttempts ?? 1;
    const retrying = attempts < CHECKIN_BACKGROUND_MAX_ATTEMPTS;
    await ctx.db.patch(row._id, {
      reflectionReconcileStatus: 'failed',
      reflectionReconcileClaimedAt: undefined,
      reflectionReconcileNextAt: retrying ? ts + checkinRetryDelayMs(attempts) : undefined,
      reflectionReconcileError: truncateText(args.error.trim(), 500),
      updatedAt: ts,
    });
    return { retrying, stale: false };
  },
});

export const completeTomorrowPlan = mutation({
  args: {
    ...notificationCallerArgs,
    checkinId: v.id('albatrossDailyCheckins'),
    workId: v.id('albatrossIntents'),
    workIds: v.optional(v.array(v.string())),
    status: v.union(v.literal('ready'), v.literal('needs_input')),
  },
  handler: async (ctx, args) => {
    const userId = await notificationCallerUserId(ctx, args);
    const row = await ctx.db.get(args.checkinId);
    const work = await ctx.db.get(args.workId);
    if (!row || row.userId !== userId || !work || work.userId !== userId) {
      throw new Error('Check-in plan not found.');
    }
    if (row.tomorrowPlanStatus !== 'planning') return { stale: true };
    // Every reported sibling must belong to the caller before it is recorded.
    const workIds: string[] = [];
    for (const rawId of (args.workIds ?? []).slice(0, 12)) {
      const docId = ctx.db.normalizeId('albatrossIntents', rawId);
      if (!docId) continue;
      const sibling = await ctx.db.get(docId);
      if (sibling && sibling.userId === userId) workIds.push(String(sibling._id));
    }
    const ts = now();
    await ctx.db.patch(row._id, {
      tomorrowWorkId: args.workId,
      tomorrowWorkIds: workIds.length ? workIds : [String(args.workId)],
      tomorrowPlanStatus: args.status,
      tomorrowPlanClaimedAt: undefined,
      tomorrowPlanNextAt: undefined,
      tomorrowPlanError: undefined,
      updatedAt: ts,
    });
    return { stale: false };
  },
});

export const failTomorrowPlan = mutation({
  args: {
    ...notificationCallerArgs,
    checkinId: v.id('albatrossDailyCheckins'),
    workId: v.optional(v.id('albatrossIntents')),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await notificationCallerUserId(ctx, args);
    const row = await ctx.db.get(args.checkinId);
    if (!row || row.userId !== userId) throw new Error('Check-in not found.');
    if (row.tomorrowPlanStatus !== 'planning') return { retrying: false, stale: true };
    const ts = now();
    const attempts = row.tomorrowPlanAttempts ?? 1;
    const retrying = attempts < CHECKIN_BACKGROUND_MAX_ATTEMPTS;
    await ctx.db.patch(row._id, {
      ...(args.workId ? { tomorrowWorkId: args.workId } : {}),
      tomorrowPlanStatus: 'failed',
      tomorrowPlanClaimedAt: undefined,
      tomorrowPlanNextAt: retrying ? ts + checkinRetryDelayMs(attempts) : undefined,
      tomorrowPlanError: truncateText(args.error.trim(), 500),
      updatedAt: ts,
    });
    return { retrying, stale: false };
  },
});

export const releaseReflectionReconcile = internalMutation({
  args: { checkinId: v.id('albatrossDailyCheckins') },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.checkinId);
    if (!row || row.reflectionReconcileStatus !== 'processing') return;
    const ts = now();
    const attempts = row.reflectionReconcileAttempts ?? 1;
    await ctx.db.patch(row._id, {
      reflectionReconcileStatus: 'failed',
      reflectionReconcileClaimedAt: undefined,
      reflectionReconcileNextAt:
        attempts < CHECKIN_BACKGROUND_MAX_ATTEMPTS ? ts + checkinRetryDelayMs(attempts) : undefined,
      reflectionReconcileError: 'The background check did not answer.',
      updatedAt: ts,
    });
  },
});

export const releaseTomorrowPlan = internalMutation({
  args: { checkinId: v.id('albatrossDailyCheckins') },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.checkinId);
    if (!row || row.tomorrowPlanStatus !== 'planning') return;
    const ts = now();
    const attempts = row.tomorrowPlanAttempts ?? 1;
    await ctx.db.patch(row._id, {
      tomorrowPlanStatus: 'failed',
      tomorrowPlanClaimedAt: undefined,
      tomorrowPlanNextAt:
        attempts < CHECKIN_BACKGROUND_MAX_ATTEMPTS ? ts + checkinRetryDelayMs(attempts) : undefined,
      tomorrowPlanError: 'Tomorrow planning did not answer.',
      updatedAt: ts,
    });
  },
});

async function runCheckinBackgroundTick(ctx: ActionCtx, kind: 'reflection' | 'tomorrow') {
  const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
  const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
  if (!appUrl || !secret) {
    console.error(`[checkin-${kind} cron] missing LAB86_MAIL_PUBLIC_URL or internal secret`);
    return;
  }
  const refs = internal.albatrossNotifications as any;
  const candidates = await ctx.runQuery(
    kind === 'reflection' ? refs.reflectionReconcileCandidates : refs.tomorrowPlanCandidates,
    {},
  );
  let completed = 0;
  for (const candidate of candidates) {
    const claim = await ctx.runMutation(
      kind === 'reflection' ? refs.beginReflectionReconcile : refs.beginTomorrowPlan,
      { checkinId: candidate._id },
    );
    if (!claim) continue;
    const ok =
      (await fanOutInternalPost(`${appUrl}/api/cron/checkin-${kind}`, secret, [claim], {
        label: `checkin-${kind} cron`,
        timeoutMs: 240_000,
        concurrency: 1,
      })) === 1;
    if (ok) completed += 1;
    else {
      await ctx.runMutation(
        kind === 'reflection' ? refs.releaseReflectionReconcile : refs.releaseTomorrowPlan,
        { checkinId: candidate._id },
      );
    }
  }
  if (candidates.length) {
    console.log(`[checkin-${kind} cron] completed ${completed}/${candidates.length}`);
  }
}

export const reflectionReconcileTick = internalAction({
  args: {},
  handler: (ctx) => runCheckinBackgroundTick(ctx, 'reflection'),
});

export const tomorrowPlanTick = internalAction({
  args: {},
  handler: (ctx) => runCheckinBackgroundTick(ctx, 'tomorrow'),
});

export const queueWorkConductorNotice = internalMutation({
  args: {
    userId: v.string(),
    workId: v.string(),
    title: v.string(),
    body: v.string(),
    dedupeKey: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('albatrossNotifications')
      .withIndex('by_user_dedupe', (q) => q.eq('userId', args.userId).eq('dedupeKey', args.dedupeKey))
      .unique();
    if (existing) return { created: false, notificationId: existing._id };
    const preference = await ctx.db
      .query('albatrossNotificationPreferences')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .unique();
    const ts = now();
    const notificationId = await ctx.db.insert(
      'albatrossNotifications',
      notificationPayload({
        userId: args.userId,
        type: 'work_question',
        title: truncateText(args.title, 180),
        body: truncateText(args.body, 1_000),
        entityKind: 'work',
        entityId: args.workId,
        deepLink: `/?view=albatrosses&work=${encodeURIComponent(args.workId)}`,
        dedupeKey: args.dedupeKey.slice(0, 500),
        scheduledFor: ts,
      }),
    );
    await ensureInAppDelivery(ctx, {
      userId: args.userId,
      notificationId,
      enabled: preference?.inAppEnabled !== false,
      timestamp: ts,
    });
    return { created: true, notificationId };
  },
});

/** A dormant Work reached its wake date. One calm line, once per sleep date. */
export const queueHorizonWake = internalMutation({
  args: {
    userId: v.string(),
    workId: v.string(),
    title: v.string(),
    notBefore: v.number(),
  },
  handler: async (ctx, args) => {
    const dedupeKey = `horizon-wake:${args.workId}:${args.notBefore}`;
    const existing = await ctx.db
      .query('albatrossNotifications')
      .withIndex('by_user_dedupe', (q) => q.eq('userId', args.userId).eq('dedupeKey', dedupeKey))
      .unique();
    if (existing) return { created: false, notificationId: existing._id };
    const preference = await ctx.db
      .query('albatrossNotificationPreferences')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .unique();
    const ts = now();
    const notificationId = await ctx.db.insert(
      'albatrossNotifications',
      notificationPayload({
        userId: args.userId,
        type: 'work_wake',
        title: truncateText(wakeLine(args.title), 180),
        body: 'Open it when you have time. Albatross did not move it.',
        entityKind: 'work',
        entityId: args.workId,
        deepLink: `/?view=albatrosses&work=${encodeURIComponent(args.workId)}`,
        dedupeKey,
        scheduledFor: ts,
      }),
    );
    await ensureInAppDelivery(ctx, {
      userId: args.userId,
      notificationId,
      enabled: preference?.inAppEnabled !== false,
      timestamp: ts,
    });
    return { created: true, notificationId };
  },
});

export const missedMoveTick = internalAction({
  args: {},
  handler: async (ctx) => {
    const candidates = await ctx.runQuery((internal as any).albatrossWorkV2.missedRecoveryCandidates, {});
    for (const candidate of candidates) {
      await ctx.runMutation((internal as any).albatrossNotifications.queueWorkConductorNotice, {
        userId: candidate.userId,
        workId: candidate.workId,
        title: 'That block passed',
        body: `Choose what happens next for “${candidate.stepTitle}”: move it, make it smaller, rebuild it, or mark it done.`,
        dedupeKey: `missed-move:${candidate.workId}:${candidate.scheduledStartAt}`,
      });
    }
  },
});

export const stalenessReviewTick = internalAction({
  args: {},
  handler: async (ctx) => {
    const candidates = await ctx.runQuery((internal as any).albatrossWorkV2.stalenessReviewCandidates, {});
    for (const candidate of candidates) {
      await ctx.runMutation((internal as any).albatrossNotifications.queueWorkConductorNotice, {
        userId: candidate.userId,
        workId: candidate.workId,
        title: 'Still carrying this?',
        body: `“${candidate.workTitle}” has been quiet. Keep it moving, pause it, or put it down.`,
        dedupeKey: `stale-work:${candidate.workId}:${candidate.updatedAt}`,
      });
    }
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
      const { notificationIds, openNotificationIds } = await ensureDailyAlignmentNotifications(ctx, {
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
        openNotificationIds,
        created: false,
      };
    }
    const dayEnd = localDayStartUtc(args.timezone, args.localDate) + 36 * 60 * 60 * 1000;
    const [activeWork, activeProjects, cards] = await Promise.all([
      ctx.db
        .query('albatrossIntents')
        .withIndex('by_user_updatedAt', (q) => q.eq('userId', args.userId))
        .order('desc')
        .take(120),
      ctx.db
        .query('albatrossProjects')
        .withIndex('by_user_updatedAt', (q) => q.eq('userId', args.userId))
        .order('desc')
        .take(80),
      ctx.db
        .query('cards')
        .withIndex('by_user_updatedAt', (q) => q.eq('userId', args.userId))
        .order('desc')
        .take(200),
    ]);
    const candidates: Array<{
      kind: 'work' | 'project' | 'task' | 'event' | 'artifact';
      id: string;
      title: string;
      suggestedState?: string;
      evidence: Array<{ kind: string; id: string; label?: string }>;
    }> = [];
    // Reflection must be able to resolve older, still-open digital work—not
    // only records the user already touched today. Bound each source family so
    // Work, Projects, and tasks all remain represented in the 60-item corpus.
    for (const work of activeWork
      .filter(
        (work) =>
          work.updatedAt <= dayEnd &&
          work.workState !== 'done' &&
          work.workState !== 'archived' &&
          work.status !== 'done' &&
          work.status !== 'archived',
      )
      .slice(0, 20)) {
      candidates.push({
        kind: 'work',
        id: String(work._id),
        title: work.title || truncateText(work.rawText, 120),
        suggestedState: 'moved',
        evidence: [{ kind: 'work', id: String(work._id), label: work.title }],
      });
    }
    for (const project of activeProjects
      .filter(
        (project) =>
          project.updatedAt <= dayEnd && project.status !== 'done' && project.status !== 'archived',
      )
      .slice(0, 20)) {
      candidates.push({
        kind: 'project',
        id: String(project._id),
        title: project.title,
        suggestedState: 'moved',
        evidence: [{ kind: 'project', id: String(project._id), label: project.title }],
      });
    }
    for (const card of cards.filter((card) => !card.completedAt && card.updatedAt <= dayEnd).slice(0, 20)) {
      candidates.push({
        kind: 'task',
        id: String(card._id),
        title: card.title,
        suggestedState: 'moved',
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
    const { notificationIds, openNotificationIds } = await ensureDailyAlignmentNotifications(ctx, {
      userId: args.userId,
      checkinId,
      localDate: args.localDate,
      candidateCount: candidates.length,
    });
    return {
      checkin: await ctx.db.get(checkinId),
      notificationId: notificationIds[0],
      notificationIds,
      openNotificationIds,
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
    const byKey = (dedupeKey: string) =>
      ctx.db
        .query('albatrossNotifications')
        .withIndex('by_user_dedupe', (q) => q.eq('userId', args.userId).eq('dedupeKey', dedupeKey))
        .unique();
    const reflection =
      (await byKey(`daily-checkin:${checkin.localDate}:reflection`)) ??
      (await byKey(`daily-checkin:${checkin.localDate}`));
    const tomorrow = await byKey(`daily-checkin:${checkin.localDate}:tomorrow`);
    // Deliver only the prompt that is still open. An answered reflection
    // must not come back in the fallback email (WRK-14).
    const reflectionOpen = !checkin.responseText?.trim();
    const tomorrowOpen = !checkin.tomorrowIntentText?.trim();
    const notification = reflectionOpen ? reflection : tomorrowOpen ? tomorrow : null;
    const subscriptions = await ctx.db
      .query('webPushSubscriptions')
      .withIndex('by_user_status', (q) => q.eq('userId', args.userId).eq('status', 'active'))
      .collect();
    const mobileDevices = await ctx.db
      .query('mobilePushDevices')
      .withIndex('by_user_status', (q) => q.eq('userId', args.userId).eq('status', 'active'))
      .collect();
    // One check-in sends each channel once, whichever prompt it carried.
    const deliveries = (
      await Promise.all(
        [reflection, tomorrow]
          .filter((row): row is NonNullable<typeof row> => Boolean(row))
          .map((row) =>
            ctx.db
              .query('notificationDeliveries')
              .withIndex('by_notification', (q) => q.eq('notificationId', row._id))
              .collect(),
          ),
      )
    ).flat();
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
        error: truncateText(args.error, 500),
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
      error: truncateText(args.error, 500),
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
      error: truncateText(args.error, 500),
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

// ---------------------------------------------------------------------------
// Quiet hours, VIP senders, and priority-only mail push (FEATURES item 12).
// The ingest scan decides push-or-hold (lib/notifications/mail-push.ts); a
// held mail notification keeps its in-app row and waits here for the digest.
// ---------------------------------------------------------------------------

async function preferenceRow(ctx: QueryCtx | MutationCtx, userId: string) {
  return await ctx.db
    .query('albatrossNotificationPreferences')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .unique();
}

export const mailPushSettings = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return mailPushSettingsFromRow(await preferenceRow(ctx, args.userId));
  },
});

const hourValidator = v.number();

export const saveMailPushSettings = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    mode: v.optional(v.union(v.literal('all'), v.literal('priority'))),
    quietHoursEnabled: v.optional(v.boolean()),
    quietHoursStart: v.optional(hourValidator),
    quietHoursEnd: v.optional(hourValidator),
    vipSenders: v.optional(v.array(v.string())),
    addVipSenders: v.optional(v.array(v.string())),
    removeVipSenders: v.optional(v.array(v.string())),
    // Used only when the user has no preference row yet.
    timezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    for (const hour of [args.quietHoursStart, args.quietHoursEnd]) {
      if (hour !== undefined && !(Number.isInteger(hour) && hour >= 0 && hour <= 23)) {
        throw new Error('Quiet hours must be whole hours from 0 to 23.');
      }
    }
    const existing = await preferenceRow(ctx, args.userId);
    const current = mailPushSettingsFromRow(existing);
    let vip = args.vipSenders !== undefined ? normalizeVipSenders(args.vipSenders) : current.vipSenders;
    if (args.addVipSenders?.length) {
      const added = normalizeVipSenders(args.addVipSenders);
      if (!added.length) throw new Error('Enter an email address or a domain.');
      vip = normalizeVipSenders([...vip, ...added]);
    }
    if (args.removeVipSenders?.length) {
      const removed = new Set(normalizeVipSenders(args.removeVipSenders));
      vip = vip.filter((entry) => !removed.has(entry));
    }
    const ts = now();
    const patch = {
      mailPushMode: args.mode ?? current.mode,
      quietHoursEnabled: args.quietHoursEnabled ?? current.quietHours.enabled,
      quietHoursStart: args.quietHoursStart ?? current.quietHours.start,
      quietHoursEnd: args.quietHoursEnd ?? current.quietHours.end,
      vipSenders: vip,
      updatedAt: ts,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return mailPushSettingsFromRow({ ...existing, ...patch });
    }
    const timezone = args.timezone?.trim() || DEFAULT_TZ;
    const doc = {
      userId: args.userId,
      timezone,
      eveningCheckinEnabled: true,
      eveningCheckinLocalTime: DEFAULT_CHECKIN_TIME,
      inAppEnabled: true,
      webPushEnabled: false,
      emailFallbackEnabled: true,
      emailFallbackDelayMinutes: DEFAULT_EMAIL_DELAY,
      ...patch,
      createdAt: ts,
    };
    await ctx.db.insert('albatrossNotificationPreferences', doc);
    return mailPushSettingsFromRow(doc);
  },
});

/** Holds the push of one mail notification until `until`. The in-app row stays. */
export const holdMailPush = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    notificationId: v.id('albatrossNotifications'),
    until: v.number(),
    reason: v.union(v.literal('quiet_hours'), v.literal('priority_only')),
    accountId: v.string(),
    threadId: v.string(),
    messageId: v.optional(v.string()),
    sender: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db.get(args.notificationId);
    if (!row || row.userId !== args.userId) throw new Error('Notification not found.');
    const ts = now();
    await ctx.db.patch(args.notificationId, {
      pushHeldUntil: Math.max(args.until, ts),
      pushHold: {
        reason: args.reason,
        accountId: args.accountId,
        threadId: args.threadId,
        messageId: args.messageId,
        sender: args.sender?.slice(0, 180),
        heldAt: ts,
      },
      updatedAt: ts,
    });
    return { held: true };
  },
});

async function heldRows(ctx: QueryCtx | MutationCtx, userId: string, limit = 200) {
  return await ctx.db
    .query('albatrossNotifications')
    .withIndex('by_user_push_held', (q) => q.eq('userId', userId).gt('pushHeldUntil', 0))
    .take(limit);
}

/**
 * Priority-only holds whose thread now needs a reply or an action. Jev
 * classifies after ingest, so mail held as ordinary can turn out to matter.
 */
export const priorityHeldMail = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const out: string[] = [];
    for (const row of await heldRows(ctx, args.userId, 50)) {
      if (row.pushHold?.reason !== 'priority_only') continue;
      const thread = await ctx.db
        .query('mailCorpusThreads')
        .withIndex('by_user_account_thread', (q) =>
          q
            .eq('userId', args.userId)
            .eq('accountId', row.pushHold!.accountId)
            .eq('providerThreadId', row.pushHold!.threadId),
        )
        .first();
      if (thread?.jevNeedsReply || thread?.jevNeedsAction) out.push(String(row._id));
    }
    return { notificationIds: out };
  },
});

/** Ends the hold of one notification so its own push can go out now. */
export const releaseHeldMailPush = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    notificationId: v.id('albatrossNotifications'),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db.get(args.notificationId);
    if (!row || row.userId !== args.userId || !row.pushHeldUntil || !row.pushHold) return { released: false };
    const ts = now();
    await ctx.db.patch(args.notificationId, {
      pushHeldUntil: undefined,
      pushHold: { ...row.pushHold, releasedAt: ts },
      updatedAt: ts,
    });
    return { released: true };
  },
});

async function dueDigestUserIds(ctx: QueryCtx, at: number, limit: number) {
  const rows = await ctx.db
    .query('albatrossNotifications')
    .withIndex('by_push_held', (q) => q.gt('pushHeldUntil', 0).lte('pushHeldUntil', at))
    .take(limit);
  return [...new Set(rows.map((row) => row.userId))];
}

/** Users with at least one held mail push that is due. */
export const dueMailDigestUsers = query({
  args: {
    internalSecret: v.optional(v.string()),
    now: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 500), 1), 2000);
    return { userIds: await dueDigestUserIds(ctx, args.now ?? now(), limit) };
  },
});

export const hasDueMailDigests = internalQuery({
  args: {},
  handler: async (ctx) => (await dueDigestUserIds(ctx, now(), 1)).length > 0,
});

/**
 * Sends the held mail of one user as one push. A single held message pushes
 * as itself; two or more become one digest notification. Every hold clears.
 */
export const claimMailDigest = mutation({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = args.now ?? now();
    const held = await heldRows(ctx, args.userId);
    if (!held.some((row) => (row.pushHeldUntil ?? 0) <= ts)) return { kind: 'none' as const, count: 0 };
    if (held.length === 1) {
      const [row] = held;
      await ctx.db.patch(row._id, {
        pushHeldUntil: undefined,
        pushHold: row.pushHold ? { ...row.pushHold, releasedAt: ts } : undefined,
        updatedAt: ts,
      });
      return { kind: 'single' as const, count: 1, notificationId: String(row._id) };
    }
    const copy = digestCopy(
      held.map((row) => row.pushHold?.sender || row.title),
      held.length,
    );
    const digestId = await ctx.db.insert(
      'albatrossNotifications',
      notificationPayload({
        userId: args.userId,
        type: 'mail_message',
        title: copy.title,
        body: copy.body,
        deepLink: '/mail',
        dedupeKey: `mail-digest:${args.userId}:${ts}`,
        scheduledFor: ts,
      }),
    );
    await ensureInAppDelivery(ctx, {
      userId: args.userId,
      notificationId: digestId,
      enabled: true,
      timestamp: ts,
    });
    for (const row of held) {
      await ctx.db.patch(row._id, {
        pushHeldUntil: undefined,
        pushHold: row.pushHold ? { ...row.pushHold, releasedAt: ts, digestId } : undefined,
        updatedAt: ts,
      });
    }
    return { kind: 'digest' as const, count: held.length, notificationId: String(digestId) };
  },
});

// Every 15 minutes: when a held mail push is due, ask the app to send the
// digests. The app owns APNs and the quiet-hours check in the user's zone.
export const mailDigestTick = internalAction({
  args: {},
  handler: async (ctx) => {
    const due = await ctx.runQuery((internal as any).albatrossNotifications.hasDueMailDigests, {});
    if (!due) return;
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) {
      console.error('[mail-digest cron] missing LAB86_MAIL_PUBLIC_URL or LAB86_CONVEX_INTERNAL_SECRET');
      return;
    }
    await fanOutInternalPost(`${appUrl}/api/cron/mail-digest`, secret, [{}], { label: 'mail-digest cron' });
  },
});

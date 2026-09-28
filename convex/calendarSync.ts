import { internal } from './_generated/api';
import { internalAction, internalQuery } from './_generated/server';
import { fanOutInternalPost } from './lib';

/**
 * Users with at least one connected mailbox. It reads only the connected
 * account rows through the status index, not every account and calendar row
 * like the Brief target list.
 */
export const syncTargets = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_status_user', (q) => q.eq('status', 'connected'))
      .collect();
    return [...new Set(accounts.map((account) => account.userId))];
  },
});

// Periodic calendar poll. Webhooks (event.created/updated/deleted) are the
// primary path, but a short-interval poll catches anything the webhook missed
// (provider delays, dropped deliveries) so edits made elsewhere surface fast.
// Sync runs in the Next.js app (Nylas lives there), reached over the
// internal-secret-gated route; the route ACKs immediately and syncs in the
// background, so this stays fast.
export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) {
      console.error('[calendar-sync cron] missing LAB86_MAIL_PUBLIC_URL or LAB86_CONVEX_INTERNAL_SECRET');
      return;
    }
    const userIds = await ctx.runQuery(internal.calendarSync.syncTargets, {});
    const ok = await fanOutInternalPost(
      `${appUrl}/api/cron/calendar-sync`,
      secret,
      userIds.map((userId) => ({ userId })),
      { label: 'calendar-sync cron' },
    );
    console.log(`[calendar-sync cron] polled ${ok}/${userIds.length} users`);
  },
});

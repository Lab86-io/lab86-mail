import { internal } from './_generated/api';
import { internalAction } from './_generated/server';
import { fanOutInternalPost } from './lib';

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
    const targets = await ctx.runQuery(internal.dailyReports.reportTargets, {});
    const ok = await fanOutInternalPost(
      `${appUrl}/api/cron/calendar-sync`,
      secret,
      targets.map((target) => ({ userId: target.userId })),
      { label: 'calendar-sync cron' },
    );
    console.log(`[calendar-sync cron] polled ${ok}/${targets.length} users`);
  },
});

import { internal } from './_generated/api';
import { internalAction } from './_generated/server';

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
    let ok = 0;
    for (const target of targets) {
      try {
        const res = await fetch(`${appUrl}/api/cron/calendar-sync`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-lab86-internal-secret': secret },
          body: JSON.stringify({ userId: target.userId }),
        });
        if (res.ok) ok += 1;
        else console.error('[calendar-sync cron] app returned', res.status, 'for', target.userId);
      } catch (err) {
        console.error('[calendar-sync cron] fetch failed for', target.userId, err);
      }
    }
    console.log(`[calendar-sync cron] polled ${ok}/${targets.length} users`);
  },
});

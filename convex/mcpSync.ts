// @ts-nocheck
import { internal } from './_generated/api';
import { internalAction } from './_generated/server';
import { fanOutInternalPost } from './lib';

// Periodic poll of each user's connected tool servers/APIs. The
// actual remote-MCP IO runs in the Next.js app (the SDK + tokens live there),
// reached over the internal-secret-gated route; the route ACKs immediately and
// syncs in the background, so this stays fast.
export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) {
      console.error('[mcp-sync cron] missing LAB86_MAIL_PUBLIC_URL or LAB86_CONVEX_INTERNAL_SECRET');
      return;
    }
    const userIds = await ctx.runQuery(internal.mcp.listSyncTargetUserIds, {});
    const ok = await fanOutInternalPost(
      `${appUrl}/api/cron/mcp-sync`,
      secret,
      userIds.map((userId) => ({ userId })),
      { label: 'mcp-sync cron' },
    );
    console.log(`[mcp-sync cron] polled ${ok}/${userIds.length} users`);
  },
});

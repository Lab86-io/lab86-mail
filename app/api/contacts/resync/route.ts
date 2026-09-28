import { NextRequest, NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { maybeKickContactSync } from '@/lib/contacts/sync';
import { api, convexQuery } from '@/lib/hosted/convex';
import type { NylasAccountRow } from '@/lib/nylas/provider';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ContactsResyncDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  listAccounts: (userId: string) => Promise<NylasAccountRow[]>;
  kick: typeof maybeKickContactSync;
}

const defaultDependencies: ContactsResyncDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  listAccounts: (userId) => convexQuery<NylasAccountRow[]>(api.accounts.listConnectedAccounts, { userId }),
  kick: maybeKickContactSync,
};

// Settings, "Sync contacts": one forced pass for one connected mailbox.
export function createContactsResyncPost(deps: ContactsResyncDependencies = defaultDependencies) {
  return async function POST(req: NextRequest) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'contacts_resync',
        limit: 10,
        windowMs: 10 * 60_000,
      });
      const body = await req.json().catch(() => ({}));
      const accountId = String(body?.accountId || '');
      if (!accountId) {
        return NextResponse.json({ ok: false, error: 'accountId is required' }, { status: 400 });
      }
      const account = (await deps.listAccounts(user.userId)).find((row) => row.accountId === accountId);
      if (!account) {
        return NextResponse.json({ ok: false, error: 'connected account not found' }, { status: 404 });
      }
      if (account.status !== 'connected') {
        return NextResponse.json(
          { ok: false, error: 'Reconnect this mailbox before you sync its contacts.' },
          { status: 409 },
        );
      }
      const started = deps.kick({ userId: user.userId, accountId }, { force: true, reason: 'manual_resync' });
      return NextResponse.json({ ok: true, started });
    } catch (err: any) {
      if (err instanceof RateLimitError) return rateLimitJson(err);
      if (err instanceof AuthRequiredError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 401 });
      }
      throw err;
    }
  };
}

export const POST = createContactsResyncPost();

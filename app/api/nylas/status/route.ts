import { NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { loadContactStatuses } from '@/lib/contacts/lookup';
import { api, convexQuery } from '@/lib/hosted/convex';
import { isNylasConfigured } from '@/lib/hosted/env';
import { mailProviderCapabilities } from '@/lib/mail/provider-capabilities';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaults = {
  requireCurrentUser,
  listAccounts: (userId: string) => convexQuery<any[]>(api.accounts.listConnectedAccounts, { userId }),
  listSyncStates: (userId: string) =>
    convexQuery<any[]>(api.mailCorpus.listSyncTargets, { userId, limit: 500 }),
  loadContactStatuses: (userId: string) => loadContactStatuses(userId),
};

export function createNylasStatusGet(deps = defaults) {
  return async function nylasStatusGet() {
    const user = await deps.requireCurrentUser().catch((err) => {
      if (err instanceof AuthRequiredError) return null;
      throw err;
    });
    if (!user) {
      return NextResponse.json({ ok: false, error: 'Sign in required.' }, { status: 401 });
    }
    const [accounts, syncStates, contacts] = await Promise.all([
      deps.listAccounts(user.userId),
      deps.listSyncStates(user.userId),
      // Contact state is extra detail: Settings still loads when it fails.
      deps.loadContactStatuses(user.userId).catch(() => []),
    ]);
    return NextResponse.json({
      ok: true,
      configured: {
        convex: true,
        nylas: isNylasConfigured(),
      },
      capabilities: mailProviderCapabilities(),
      accounts,
      syncStates,
      contacts,
    });
  };
}

export const GET = createNylasStatusGet();

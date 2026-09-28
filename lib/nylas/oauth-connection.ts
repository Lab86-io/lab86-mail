import { syncCalendarAccount } from '@/lib/calendar/sync';
import { maybeKickContactSync } from '@/lib/contacts/sync';
import { api, convexMutation } from '@/lib/hosted/convex';
import { nylasRedirectUri } from '@/lib/hosted/env';
import { maybeKickCorpusBackfill } from '@/lib/mail/corpus-sync';
import { requireNylas } from '@/lib/nylas/client';
import { encryptSecret } from '@/lib/security/crypto';

// The provider result that a native mailbox callback keeps until the signed-in
// app redeems it (see lib/security/oauth-completions.ts).
export interface NylasOAuthCompletionPayload {
  code: string;
  provider?: string;
}

const defaultDependencies = {
  convexMutation,
  requireNylas,
  encryptSecret,
  nylasRedirectUri,
  syncCalendarAccount,
  maybeKickCorpusBackfill,
  maybeKickContactSync,
};

export type NylasOAuthConnectionDependencies = typeof defaultDependencies;

/**
 * Exchanges an authorization code and attaches the mailbox to `userId`. The
 * caller must first prove that `userId` is the signed-in user: the web
 * callback compares the Clerk session, and the native finalize route reads
 * the user from the app's bearer token.
 */
export async function completeNylasConnection(
  input: { userId: string; code: string; provider?: string },
  dependencies: Partial<NylasOAuthConnectionDependencies> = {},
): Promise<{ accountId?: string }> {
  const deps = { ...defaultDependencies, ...dependencies };
  const token = await deps.requireNylas().auth.exchangeCodeForToken({
    clientId: process.env.NYLAS_CLIENT_ID || '',
    clientSecret: process.env.NYLAS_CLIENT_SECRET || undefined,
    redirectUri: deps.nylasRedirectUri(),
    code: input.code,
  });
  const provider = normalizeProvider(token.provider || input.provider || '');
  const scopes = String(token.scope || '')
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const upserted = await deps.convexMutation<{
    accountId: string;
    replacedGrantId?: string;
  }>(api.accounts.upsertConnectedAccount, {
    userId: input.userId,
    email: token.email,
    provider,
    grantId: token.grantId,
    accessTokenEncrypted: token.accessToken ? deps.encryptSecret(token.accessToken) : undefined,
    refreshTokenEncrypted: token.refreshToken ? deps.encryptSecret(token.refreshToken) : undefined,
    expiresAt: token.expiresIn ? Date.now() + token.expiresIn * 1000 : undefined,
    scopes,
  });
  if (upserted?.replacedGrantId) {
    await deps
      .requireNylas()
      .grants.destroy({ grantId: upserted.replacedGrantId })
      .catch(() => undefined);
  }
  if (upserted?.accountId) {
    const kick = { userId: input.userId, accountId: upserted.accountId };
    void (async () => {
      await deps
        .syncCalendarAccount({ ...kick, force: true, reason: 'oauth_callback' })
        .catch(() => undefined);
      deps.maybeKickCorpusBackfill(kick);
      // A reconnect that added contact scopes syncs contacts at once.
      deps.maybeKickContactSync(kick, { force: true, reason: 'oauth_callback' });
    })();
  }
  return { accountId: upserted?.accountId };
}

export function normalizeProvider(provider: string) {
  if (provider === 'google' || provider === 'microsoft' || provider === 'icloud') return provider;
  return 'imap';
}

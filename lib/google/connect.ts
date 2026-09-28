// Direct Google transport: the mailbox sign-in (docs/google-direct-transport.md).
//
// Three modes:
// - `switch` moves an existing Nylas Google account to Gmail in place. The
//   Gmail address must equal the account address.
// - `reconnect` renews the sign-in of an account that is on Gmail already.
// - `new` connects a Google account. If the user has an account with the same
//   address, it switches or reconnects that account instead of adding one.
//
// The web callback needs a signed-in session of the same user. A native flow
// gets a single-use completion token, and the signed-in app redeems it
// through the finalize route. This is the Files pattern.

import { randomBytes, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { syncCalendarAccount } from '@/lib/calendar/sync';
import { maybeKickContactSync } from '@/lib/contacts/sync';
import { isStagingRuntime } from '@/lib/hosted/controls';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { hostedPublicUrl } from '@/lib/hosted/env';
import { maybeKickCorpusBackfill, reconcileMailCorpusAccount } from '@/lib/mail/corpus-sync';
import type { NylasAccountRow } from '@/lib/nylas/provider';
import { decryptSecret, encryptSecret } from '@/lib/security/crypto';
import { sanitizeInternalPath } from '@/lib/security/redirect';
import {
  buildGoogleMailAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
  fetchGmailProfile,
  fetchGoogleUserInfo,
  GMAIL_MODIFY_SCOPE,
  googleOAuthClient,
  grantedScopes,
  pkcePair,
} from './oauth';
import { forgetGoogleAccessToken } from './tokens';
import { googleDirectGrantId, isGoogleDirectEnabled, isGoogleDirectGrant } from './transport';

export type GoogleMailMode = 'switch' | 'new' | 'reconnect';
export type GoogleMailOutcome = 'switched' | 'reconnected' | 'created';

const STATE_TTL_MS = 10 * 60_000;
const COMPLETION_TTL_MS = 5 * 60_000;
const DEFAULT_REDIRECT = '/settings';
export const NATIVE_MAIL_CALLBACK = 'lab86://oauth/mail';

/** An error with a status and a message that the user can see. */
export class GoogleConnectError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GoogleConnectError';
    this.status = status;
  }
}

type Env = Record<string, string | undefined>;

/**
 * Switching a Nylas account to Gmail is on where new direct connections are
 * on, on staging, or where LAB86_GOOGLE_DIRECT_SWITCH=1. So the owner can
 * switch one staging account without a variable change.
 */
export function isGoogleDirectSwitchAllowed(env: Env = process.env, host?: string | null): boolean {
  return isGoogleDirectEnabled(env) || env.LAB86_GOOGLE_DIRECT_SWITCH === '1' || isStagingRuntime(host);
}

const defaults = {
  query: convexQuery,
  mutate: convexMutation,
  encryptSecret,
  decryptSecret,
  googleOAuthClient: () => googleOAuthClient(),
  exchangeGoogleAuthorizationCode,
  fetchGmailProfile: (accessToken: string) => fetchGmailProfile(accessToken),
  fetchGoogleUserInfo: (accessToken: string) => fetchGoogleUserInfo(accessToken),
  requireCurrentUser,
  randomState: () => randomBytes(32).toString('base64url'),
  randomUUID: (): string => randomUUID(),
  now: () => Date.now(),
  env: (): Env => process.env,
  afterConnect: (input: { userId: string; accountId: string; outcome: GoogleMailOutcome }) => {
    kickAfterConnect(input);
  },
};
let deps = defaults;

export function __setGoogleConnectDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
}

function kickAfterConnect({
  userId,
  accountId,
  outcome,
}: {
  userId: string;
  accountId: string;
  outcome: GoogleMailOutcome;
}) {
  const kick = { userId, accountId };
  void (async () => {
    // A new account needs its corpus; a switched one has it and only catches
    // up the newest page, in case mail came in during the switch.
    if (outcome === 'created') maybeKickCorpusBackfill(kick);
    else await reconcileMailCorpusAccount(kick).catch(() => undefined);
    await syncCalendarAccount({ ...kick, force: true, reason: 'oauth_callback' }).catch(() => undefined);
    maybeKickContactSync(kick, { force: true, reason: 'oauth_callback' });
  })();
}

async function listAccounts(userId: string) {
  return (await deps.query<NylasAccountRow[]>(api.accounts.listConnectedAccounts, { userId })) || [];
}

function findAccount(accounts: NylasAccountRow[], ref: string | undefined) {
  const needle = String(ref || '')
    .trim()
    .toLowerCase();
  if (!needle) return null;
  return (
    accounts.find(
      (account) =>
        account.accountId === ref || account.grantId === ref || account.email?.toLowerCase() === needle,
    ) || null
  );
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export interface StartInput {
  userId: string;
  mode: GoogleMailMode;
  /** accountId, grant id, or email of the account to switch or reconnect. */
  account?: string;
  redirectTo?: string | null;
  native?: boolean;
  host?: string | null;
}

export async function startGoogleMailConnect(input: StartInput) {
  const client = deps.googleOAuthClient();
  if (!client) throw new GoogleConnectError(503, 'Google sign-in is not configured.');
  const env = deps.env();
  let mode = input.mode;
  let account: NylasAccountRow | null = null;
  if (mode === 'new') {
    if (!isGoogleDirectEnabled(env)) throw new GoogleConnectError(404, 'Direct Google connections are off.');
  } else {
    account = findAccount(await listAccounts(input.userId), input.account);
    if (!account) throw new GoogleConnectError(404, 'No connected account matches that reference.');
    if (account.provider !== 'google') {
      throw new GoogleConnectError(400, 'Only a Google account can use Gmail directly.');
    }
    if (isGoogleDirectGrant(account.grantId)) mode = 'reconnect';
    else if (!isGoogleDirectSwitchAllowed(env, input.host)) {
      throw new GoogleConnectError(403, 'Switching accounts to Gmail is off.');
    } else mode = 'switch';
  }
  const { codeVerifier, codeChallenge } = pkcePair();
  const state = deps.randomState();
  await deps.mutate(api.googleDirect.saveOAuthState, {
    userId: input.userId,
    state,
    mode,
    accountId: account?.accountId,
    redirectTo: sanitizeInternalPath(input.redirectTo || DEFAULT_REDIRECT),
    nativeCallback: input.native === true,
    codeVerifierEncrypted: deps.encryptSecret(codeVerifier),
    expiresAt: deps.now() + STATE_TTL_MS,
  });
  const authorizationUrl = buildGoogleMailAuthorizationUrl({
    clientId: client.clientId,
    state,
    codeChallenge,
    loginHint: account?.email,
  });
  return { authorizationUrl, mode, accountId: account?.accountId };
}

/**
 * Which direct flow a "connect Google" request of the Nylas connect route
 * takes, or null for Nylas. An old native build cannot redeem a completion
 * token, so a native request goes direct only when it says `finalize=1`.
 */
export async function directGoogleConnectChoice(input: {
  userId: string;
  native?: boolean;
  finalize?: boolean;
}): Promise<{ mode: GoogleMailMode; account?: string } | null> {
  if (input.native && !input.finalize) return null;
  if (!deps.googleOAuthClient()) return null;
  if (isGoogleDirectEnabled(deps.env())) return { mode: 'new' };
  // With the flag off, a direct account that needs a reconnect still
  // reconnects to Gmail, so the Reconnect button does not undo a switch.
  const accounts = await listAccounts(input.userId);
  const dead = accounts.find(
    (account) =>
      account.provider === 'google' && isGoogleDirectGrant(account.grantId) && account.status !== 'connected',
  );
  return dead ? { mode: 'reconnect', account: dead.accountId } : null;
}

// ---------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------

export interface CompleteInput {
  userId: string;
  mode: GoogleMailMode;
  accountId?: string;
  code: string;
  codeVerifier: string;
}

export async function completeGoogleMailConnect(input: CompleteInput) {
  const client = deps.googleOAuthClient();
  if (!client) throw new GoogleConnectError(503, 'Google sign-in is not configured.');
  const tokens = await deps.exchangeGoogleAuthorizationCode({
    code: input.code,
    codeVerifier: input.codeVerifier,
    client,
  });
  if (!tokens.refresh_token) {
    throw new GoogleConnectError(
      409,
      'Google did not give offline access. Remove Albatross from your Google account access, then try again.',
    );
  }
  const scopes = grantedScopes(tokens);
  if (!scopes.includes(GMAIL_MODIFY_SCOPE)) {
    throw new GoogleConnectError(
      403,
      'Albatross needs access to Gmail. Allow all the requested access, then try again.',
    );
  }
  const profile = await deps.fetchGmailProfile(tokens.access_token);
  const email = profile.emailAddress.trim().toLowerCase();
  if (input.mode !== 'new') {
    const account = findAccount(await listAccounts(input.userId), input.accountId);
    if (!account) throw new GoogleConnectError(404, 'The account to switch was not found.');
    if (account.email.toLowerCase() !== email) {
      throw new GoogleConnectError(409, `Sign in to Google as ${account.email}. You signed in as ${email}.`);
    }
  }
  const userInfo = await deps.fetchGoogleUserInfo(tokens.access_token).catch(() => null);
  const result = await deps.mutate<{
    accountId: string;
    grantId: string;
    outcome: GoogleMailOutcome;
    previousNylasGrantId?: string;
  }>(api.googleDirect.activateGoogleAccount, {
    userId: input.userId,
    mode: input.mode,
    accountId: input.accountId,
    newAccountId: deps.randomUUID(),
    email,
    displayName: userInfo?.name || undefined,
    scopes,
    accessTokenEncrypted: deps.encryptSecret(tokens.access_token),
    refreshTokenEncrypted: deps.encryptSecret(tokens.refresh_token),
    expiresAt: deps.now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000,
    historyId: profile.historyId,
  });
  forgetGoogleAccessToken(googleDirectGrantId(result.accountId));
  deps.afterConnect({ userId: input.userId, accountId: result.accountId, outcome: result.outcome });
  return result;
}

function visibleError(error: unknown, fallback: string) {
  return error instanceof GoogleConnectError ? error.message : fallback;
}

// ---------------------------------------------------------------------------
// Callback and finalize
// ---------------------------------------------------------------------------

function redirect(path: string | undefined, params: Record<string, string>, native: boolean) {
  const target = native
    ? new URL(NATIVE_MAIL_CALLBACK)
    : new URL(sanitizeInternalPath(path || DEFAULT_REDIRECT), hostedPublicUrl());
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value.slice(0, 200));
  return NextResponse.redirect(target);
}

/**
 * Handles the Files callback URL when its state belongs to the Google mail
 * store. Returns null when the state is not a Google mail state, so the
 * Files flow goes on unchanged.
 */
export async function handleGoogleMailCallback(input: {
  state: string;
  code: string;
  providerError?: string | null;
}): Promise<NextResponse | null> {
  if (!input.state) return null;
  let stored: {
    userId: string;
    mode: GoogleMailMode;
    accountId?: string;
    redirectTo?: string;
    nativeCallback?: boolean;
    codeVerifierEncrypted: string;
  } | null;
  try {
    stored = await deps.mutate(api.googleDirect.consumeOAuthState, { state: input.state });
  } catch (error) {
    console.error('[google-mail/callback] state lookup failed', (error as Error)?.message || error);
    return null;
  }
  if (!stored) return null;
  const native = stored.nativeCallback === true;
  const fail = (message: string) => redirect(stored.redirectTo, { nylas_error: message }, native);
  if (input.providerError) {
    console.warn('[google-mail/callback] authorization was not completed');
    return fail('Authorization was not completed. Try again.');
  }
  if (!input.code) return fail('Google did not return an authorization code.');
  try {
    if (native) {
      const completionToken = deps.randomState();
      await deps.mutate(api.googleDirect.saveOAuthCompletion, {
        userId: stored.userId,
        completionToken,
        mode: stored.mode,
        accountId: stored.accountId,
        authorizationCodeEncrypted: deps.encryptSecret(input.code),
        codeVerifierEncrypted: stored.codeVerifierEncrypted,
        expiresAt: deps.now() + COMPLETION_TTL_MS,
      });
      return redirect(undefined, { mail_completion: completionToken }, true);
    }
    const sessionUser = await deps.requireCurrentUser().catch(() => null);
    if (!sessionUser || sessionUser.userId !== stored.userId) {
      return fail('Sign in again, then retry the connection.');
    }
    const result = await completeGoogleMailConnect({
      userId: stored.userId,
      mode: stored.mode,
      accountId: stored.accountId,
      code: input.code,
      codeVerifier: deps.decryptSecret(stored.codeVerifierEncrypted),
    });
    return redirect(stored.redirectTo, { nylas_connected: '1', google_mail: result.outcome }, false);
  } catch (error) {
    // A refusal message names the account; the log keeps only its status.
    console.error(
      '[google-mail/callback] connection failed',
      error instanceof GoogleConnectError ? `refused ${error.status}` : (error as Error)?.message || error,
    );
    return fail(visibleError(error, 'Could not complete the Google connection. Try again.'));
  }
}

/** The authenticated finalize step of a native flow. */
export async function finalizeGoogleMailConnect(input: { userId: string; completionToken: string }) {
  const stored = await deps.mutate<{
    mode: GoogleMailMode;
    accountId?: string;
    authorizationCodeEncrypted: string;
    codeVerifierEncrypted: string;
  } | null>(api.googleDirect.consumeOAuthCompletion, input);
  if (!stored) throw new GoogleConnectError(409, 'The Google connection is invalid or expired.');
  return await completeGoogleMailConnect({
    userId: input.userId,
    mode: stored.mode,
    accountId: stored.accountId,
    code: deps.decryptSecret(stored.authorizationCodeEncrypted),
    codeVerifier: deps.decryptSecret(stored.codeVerifierEncrypted),
  });
}

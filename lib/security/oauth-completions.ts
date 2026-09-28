import { createHash, randomBytes } from 'node:crypto';
import { api, convexMutation } from '@/lib/hosted/convex';
import { decryptSecret, encryptSecret } from '@/lib/security/crypto';

// A native OAuth callback runs in the system browser with no Clerk session,
// so it cannot tell who approved the provider. It keeps the provider result
// under a single-use token for the user who started the flow. The signed-in
// app then redeems the token through an authenticated finalize route. The
// mailbox (or tool) is attached only when the redeemer is that same user.

export type OAuthCompletionKind = 'mail' | 'mcp';

/** A completion that the app does not redeem in this time is dropped. */
export const OAUTH_COMPLETION_TTL_MS = 5 * 60_000;

const defaultDependencies = {
  convexMutation,
  encryptSecret,
  decryptSecret,
  now: Date.now,
  randomToken: () => randomBytes(32).toString('base64url'),
};

export type OAuthCompletionDependencies = typeof defaultDependencies;

/** Rows keep the SHA-256 of the token only, so a row read cannot redeem it. */
export function hashOAuthCompletionToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function saveOAuthCompletion<Payload>(
  input: { userId: string; kind: OAuthCompletionKind; payload: Payload },
  dependencies: OAuthCompletionDependencies = defaultDependencies,
): Promise<string> {
  const completionToken = dependencies.randomToken();
  await dependencies.convexMutation(api.oauthCompletions.save, {
    userId: input.userId,
    kind: input.kind,
    tokenHash: hashOAuthCompletionToken(completionToken),
    payloadEncrypted: dependencies.encryptSecret(JSON.stringify(input.payload)),
    expiresAt: dependencies.now() + OAUTH_COMPLETION_TTL_MS,
  });
  return completionToken;
}

/** Returns the stored payload once, and only to the user who started the flow. */
export async function consumeOAuthCompletion<Payload>(
  input: { userId: string; kind: OAuthCompletionKind; completionToken: string },
  dependencies: OAuthCompletionDependencies = defaultDependencies,
): Promise<Payload | null> {
  const stored = await dependencies.convexMutation<{ payloadEncrypted: string } | null>(
    api.oauthCompletions.consume,
    {
      userId: input.userId,
      kind: input.kind,
      tokenHash: hashOAuthCompletionToken(input.completionToken),
    },
  );
  if (!stored) return null;
  return JSON.parse(dependencies.decryptSecret(stored.payloadEncrypted)) as Payload;
}

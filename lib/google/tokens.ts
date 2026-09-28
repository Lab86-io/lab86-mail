// Direct Google transport: access tokens.
//
// CONTRACT (the Gmail workstream implements it):
// - The refresh token lives encrypted in `providerGrants.refreshTokenEncrypted`
//   for the row whose `grantId` is `google:<accountId>`.
// - `getGoogleAccessToken` returns a live access token. It caches the token in
//   memory until shortly before `expires_in`, and it refreshes through
//   https://oauth2.googleapis.com/token with the Google OAuth client.
// - On `invalid_grant` it marks the account as needing a reconnect (the same
//   state a dead Nylas grant gets) and throws a GoogleApiError with status 401.
// - `invalidateGoogleAccessToken` drops the cached token, so the next call
//   refreshes.

export async function getGoogleAccessToken(_grantId: string): Promise<string> {
  throw new Error('Direct Google access tokens are not implemented yet.');
}

export function invalidateGoogleAccessToken(_grantId: string): void {}

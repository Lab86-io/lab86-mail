# Hosted operations

For release workflow and resource targets, read [the release runbook](hosted-release-runbook.md).

## Convex Export / Restore Runbook

Provider mail remains the source of truth for transport, but Convex stores hosted app state and the local mail
corpus used for B2C search: users, connected account metadata, encrypted provider grants, AI settings, AI usage,
entitlements/reporting mirrors, corpus sync state, webhook events, and indexed mail documents.

Before destructive production data changes:

1. Run a production export from the Convex dashboard or CLI.
2. Store the export in the Lab86 private backup location.
3. Verify the export contains expected hosted tables.
4. Document the restore target and test restore in a non-production Convex deployment.

Do not restore production data into development unless provider grants and encrypted secrets are explicitly
sanitized.

## Mail Corpus Backfill / Reconcile

Convex is the durable local mail corpus. Nylas is the interim transport used to fetch mail and receive webhook
wake signals.

These routes check the internal secret in the handler, so Clerk does not redirect them. Send the
secret as a bearer token for these internal operations.

Manual backfill for one grant-backed account:

```bash
curl --fail -X POST https://mail.lab86.io/api/mail/corpus/backfill \
  -H "Authorization: Bearer $LAB86_CONVEX_INTERNAL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"userId":"user_...","accountId":"grant_...","limit":50}'
```

If the response includes `nextPageToken`, call the endpoint again with that token until `corpusReady` is true.

Manual reconcile (there is no scheduled reconcile; webhooks and the manual call are the only paths):

```bash
curl --fail -X POST https://mail.lab86.io/api/mail/corpus/reconcile \
  -H "Authorization: Bearer $LAB86_CONVEX_INTERNAL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"limit":10,"messageLimit":50}'
```

The reconciler re-reads recent provider messages for ready accounts and repairs missed webhook delivery. It is safe
to run repeatedly; Convex upserts by `(accountId, providerMessageId)` and `(accountId, providerThreadId)`.

Local-first search rollout is controlled by provider list:

- With no variable set, local search is on for all four providers (Google, Microsoft, iCloud, IMAP).
- Set `LAB86_MAIL_LOCAL_SEARCH_PROVIDERS=<provider,...>` to limit local search to those providers.
- Set `LAB86_MAIL_LOCAL_SEARCH_DISABLED_PROVIDERS=<provider>` for instant provider rollback to Nylas structured
  search. Use `all` to force structured search for every provider.

## Privacy / Deletion Readiness

Public OAuth review URLs:

- Homepage: `https://mail.lab86.io`
- Privacy: `https://mail.lab86.io/privacy`
- Terms: `https://mail.lab86.io/terms`
- Support: `https://mail.lab86.io/support`

Deletion behavior:

- Provider disconnect calls Nylas grant revocation and deletes Lab86-hosted connected account rows, encrypted
  grant rows, cached threads/messages, corpus rows, sync state, webhook rows, and account-scoped jobs.
- Self-serve account deletion is exposed at `DELETE /api/account` through the app settings. It revokes every
  connected Nylas grant, deletes all user-scoped Convex state including AI settings/usage and rate-limit rows,
  then deletes the Clerk user.
- Provider source mail remains in the user mailbox unless the user separately runs a provider delete/trash
  action.

Verification notes:

- The privacy policy includes the Google API Services User Data Policy and Limited Use statement.
- Keep Nylas, Google, and Microsoft dashboard scopes synchronized with the public privacy policy and implemented
  UI actions.
- Account deletion and provider disconnect are auditable through Convex table-count returns and tests that
  enumerate cascade table coverage.

## Security Incident Runbook

1. Triage severity and affected providers. Preserve Railway, Convex, Nylas, Clerk, and AI-provider logs.
2. Contain by disabling signups, outbound send, corpus reconcile, or hosted AI with emergency Railway variables.
3. Rotate affected secrets in Railway and provider dashboards: Nylas, Clerk, Convex internal secret, AI keys,
   Stripe/Clerk billing secrets, and webhook signing secrets.
4. Revoke affected Nylas grants and run account deletion or provider disconnect cascades when user data exposure
   requires it.
5. Notify affected users and vendors according to contractual/legal requirements. Use Google and Microsoft
   provider security/contact channels when their OAuth data or tokens are involved.
6. Document the incident timeline, impacted tables, exposed data classes, containment actions, and follow-up
   fixes before re-enabling disabled features.

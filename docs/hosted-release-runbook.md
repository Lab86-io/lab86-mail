# Lab86 Mail Hosted Release Runbook

## Environments

| Purpose | Git branch | Railway environment | URL |
| --- | --- | --- | --- |
| Development / staging | `staging` | `development` | `https://web-development-292e.up.railway.app` |
| Production | `main` | `production` | `https://web-production-3ec2.up.railway.app` |

Runtime app variables are authoritative in Railway. GitHub stores deploy credentials only:

- `RAILWAY_TOKEN`
- `CONVEX_DEPLOY_KEY`
- `RELEASE_BOT_TOKEN` for production version commits and tags

Railway resources created on June 4, 2026:

- Project `lab86-mail`: `919576b9-789c-4257-b6cc-250cf4a28ecb`
- Service `web`: `1ee5eac3-493e-4a4b-a6b4-cb89c6e0d179`
- Environment `development`: `be41491e-6d1b-45f7-b85a-299540ac125e`
- Environment `production`: `c14045cd-da4a-4080-bc07-ff784f1e333d`
- Railway development URL: `https://web-development-292e.up.railway.app`
- Railway production URL: `https://web-production-3ec2.up.railway.app`

GitHub resources created on June 4, 2026:

- Repository: `Lab86-io/lab86-mail`
- Team: `Lab86-io/maintainers`
- Hosted release PR: `https://github.com/Lab86-io/lab86-mail/pull/1`

Convex resources created on June 4, 2026:

- Development deployment: `<convex-team>:lab86-mail:development`
  - Deployment name: `precise-skunk-847`
  - URL: `https://precise-skunk-847.convex.cloud`
  - Site URL: `https://precise-skunk-847.convex.site`
- Production deployment: `<convex-team>:lab86-mail:production`
  - Deployment name: `proficient-viper-594`
  - URL: `https://proficient-viper-594.convex.cloud`
  - Site URL: `https://proficient-viper-594.convex.site`

## Required Provider Setup

Create separate development and production resources for:

- Railway project `lab86-mail`, service `web`
- Convex deployments
- Clerk apps/instances
- Nylas apps
- Clerk Billing plans

Clerk Billing plan shape:

- Free/default: no Lab86-hosted AI budget
- Pro: $15/month or $120/year with a 500-credit internal AI budget
- Pro plan slug: `mail_pro`
- Pro feature slug: `b2c_mail`

Development uses Clerk's development billing gateway. Production connects the independent Lab86 Stripe
account through Clerk Billing.

## Dashboard Setup Still Required

These items are intentionally not DNS cutover work, but they require provider dashboards or refreshed
dashboard sessions:

- Blacksmith: verify `Lab86-io/lab86-mail` has access to Blacksmith runners. The workflow runner label is
  `blacksmith-2vcpu-ubuntu-2404`.
- Railway: create a deploy token and store it as `RAILWAY_TOKEN` in the GitHub `development` and `production`
  environments. The Railway CLI user session can deploy locally but does not expose a CI token.
- Clerk production: run `clerk deploy` with a real Lab86-owned production domain. Clerk's wizard requires DNS
  verification and does not allow using a Railway-provided subdomain as the production domain.
- Clerk OAuth: configure production Apple, Google, and Microsoft OAuth credentials during `clerk deploy`.
- Clerk Billing: enable Clerk Billing, create the Free/default and Pro plans, connect the production Lab86 Stripe
  account, and set the resulting billing URLs in Railway.
- Clerk webhooks: create the Svix/Clerk webhook endpoint for `/api/clerk/webhook`, subscribe to user and billing
  lifecycle events, then set `CLERK_WEBHOOK_SIGNING_SECRET` in Railway.
- Nylas: refresh `nylas dashboard login`, create separate development and production apps/API keys, and set the
  production Nylas values in Railway. The existing sandbox app has callbacks for
  `https://mail-staging.lab86.io/api/nylas/callback` and
  `https://web-development-292e.up.railway.app/api/nylas/callback`.
  Configure Nylas message/thread notifications to post to `/api/nylas/webhook`; the route records every event
  idempotently and re-fetches truncated message notifications before writing the Convex corpus.
- Google OAuth: before public launch, submit production OAuth verification with the public homepage, privacy
  policy, terms, and support URLs. Keep development and staging in a separate Google Cloud project so test
  sign-ins do not consume production OAuth quota. Start verification before public launch or at 70 lifetime
  production Gmail authorizations, whichever comes first.
- Google scopes: request only implemented mail scopes. With Nylas as the interim transport, keep the Nylas
  provider connector scoped to read/search/sync, send, label/move, and trash actions currently visible in the
  product. For a later direct Google driver, `gmail.modify` covers read/write/send without immediate permanent
  delete; do not request `mail.google.com` unless bypassing trash becomes an implemented feature.
- Microsoft OAuth: track Microsoft Partner Center publisher verification separately from Google verification
  before B2C launch if Microsoft consumer accounts are included in public onboarding.
- OpenRouter: enable account or guardrail privacy controls that disallow training on prompts and enforce ZDR
  routing for routed mail-content requests before enabling hosted AI in production.
- Vendor/DPA tracker: keep current terms, DPAs, and no-training/security notes for Railway, Convex, Nylas,
  Clerk, Stripe, OpenRouter, OpenAI, Anthropic, and any enabled model provider.
- CodeRabbit: install the GitHub App on `Lab86-io/lab86-mail` so PR #1 receives a review.

## Nylas Sandbox → Production Migration

The production Railway env points at a dedicated Nylas app
(`a0327d4f-cde6-4ebb-b49d-5baf9f366e31`, "Lab86 Mail Production"), but that app
is still in the **sandbox** environment, which hard-caps at **5 connected
grants**. Once full, new account connections fail with
`Maximum number of sandbox grants reached for Application`. Audit current state
any time with:

```bash
NYLAS_API_KEY=<prod key> bun scripts/nylas-provision.ts status
```

As of this writing the production app already has the callback, the webhook
(`/api/nylas/webhook`), and connectors for google/microsoft/imap/icloud/ews
created — so the connector/webhook wiring (step 5 below) is already done and the
script will report everything `present`. **The only blocker is the sandbox
environment itself.** Steps 1–4 are the real work; 5–6 are verify/cutover.

You cannot flip `sandbox → production` via API or env — it is a dashboard +
billing + OAuth process. Do it in this order (Google verification is the long
pole; start it first):

1. **Nylas paid plan → Production application.** In the Nylas dashboard, put the
   org on a paid plan and create/convert to a production application. Production
   apps have no 5-grant cap (billed per connected account beyond the plan
   quota). Sandbox grants do **not** carry over to a new app — users reconnect
   once after cutover.
2. **Google Cloud (BYO OAuth, required in v3 production).** Create an OAuth
   client + consent screen in a production Google Cloud project (keep dev/staging
   in a separate project so test sign-ins don't burn production quota). Request
   only implemented scopes — `gmail.modify` + `userinfo.email`; do **not**
   request `mail.google.com`. Submit OAuth verification and the annual **CASA
   Tier 2** assessment before public launch or at ~70 lifetime production Gmail
   authorizations, whichever comes first.

   Provisioned 2026-06-11 via gcloud as jakob@lab86.io (org lab86.io
   459734099637; project `lab86-mail-production`, number 452431903621, billing
   `016424-9F9740-E75146`). An earlier duplicate under jjalangtry@gmail.com
   (`lab86-mail-prod`) is obsolete and can be deleted.
   - APIs enabled: `gmail.googleapis.com`, `pubsub.googleapis.com`.
   - Org policy note: the lab86.io org's Domain Restricted Sharing default
     blocks the Gmail push grant; a project-level override
     (`constraints/iam.allowedPolicyMemberDomains` → allow all) was applied
     (needed roles/orgpolicy.policyAdmin granted to jakob@lab86.io at the org).
   - Service account
     `nylas-gmail-realtime@lab86-mail-production.iam.gserviceaccount.com`
     (exact name required by the Nylas connector).
   - Pub/Sub topic `projects/lab86-mail-production/topics/nylas-gmail-realtime`
     with `gmail-api-push@system.gserviceaccount.com` as Pub/Sub Publisher —
     this is the connector's "Google Pub/Sub topic name" value.
   - Authenticated push subscription `nylas-gmail-realtime-sub` →
     `https://gmailrealtime.us.nylas.com` (OIDC as the service account, never
     expires; the Pub/Sub service agent holds `iam.serviceAccountTokenCreator`).

   Console-only remainder (no API exists for external consent screens): the
   OAuth consent screen/branding, scopes, test users, and the **Web application
   OAuth client** with redirect `https://api.us.nylas.com/v3/connect/callback`
   — its client ID/secret go into the Nylas Google connector form.
3. **Microsoft (Azure).** Register an Azure app (Mail.ReadWrite, Mail.Send,
   offline_access, User.Read). Track Microsoft Partner Center publisher
   verification separately from Google.
4. **iCloud / IMAP.** No OAuth app — app-specific passwords only.
5. **Configure the production Nylas app + webhook** (scriptable once 1–4 exist):

   ```bash
   NYLAS_API_KEY=<prod key> PUBLIC_URL=https://mail.lab86.io \
   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
   MICROSOFT_CLIENT_ID=... MICROSOFT_CLIENT_SECRET=... \
   SETUP_ICLOUD=1 \
   bun scripts/nylas-provision.ts setup
   ```

   The script registers the `mail.lab86.io/api/nylas/callback` callback, creates
   the Google/Microsoft/iCloud connectors, and creates the webhook against
   `/api/nylas/webhook` (printing the one-time `webhook_secret`).
6. **Railway production env cutover.** Set the production app's
   `NYLAS_CLIENT_ID`, `NYLAS_CLIENT_SECRET`, `NYLAS_API_KEY`, and the
   `NYLAS_WEBHOOK_SECRET` printed in step 5. `NYLAS_REDIRECT_URI` already points
   at `https://mail.lab86.io/api/nylas/callback`. Redeploy and reconnect one
   account to verify, then re-run `bun scripts/nylas-provision.ts status` to
   confirm `environment: production` and the connectors/webhook are live.

Stopgap while the above is in flight: delete a sandbox grant to free a slot
(`DELETE /v3/grants/<id>` with the prod key, or revoke from the app's settings).
This keeps you at the 5-grant cap and is for testing only.

## Railway Variables

Set these in both Railway environments with environment-specific values:

- `LAB86_MAIL_PUBLIC_URL`
- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `NEXT_PUBLIC_CLERK_PROXY_URL`
- `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`
- `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up`
- `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/`
- `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/`
- `NEXT_PUBLIC_CONVEX_URL`
- `CONVEX_DEPLOYMENT`
- `NEXT_PUBLIC_CONVEX_SITE_URL`
- `LAB86_CONVEX_INTERNAL_SECRET`
- `CLERK_WEBHOOK_SIGNING_SECRET`
- `CLERK_BILLING_CHECKOUT_URL`
- `CLERK_BILLING_PORTAL_URL`
- `NYLAS_API_KEY`
- `NYLAS_CLIENT_ID`
- `NYLAS_CLIENT_SECRET`
- `NYLAS_API_URI`
- `NYLAS_REDIRECT_URI`
- `NYLAS_SCOPES`
- `LAB86_MAIL_ICLOUD_MODE=hidden`
- `LAB86_MAIL_NYLAS_ICLOUD_CONNECTOR_READY=0`
- `LAB86_MAIL_CORPUS_RECONCILE_ENABLED=1`
- `LAB86_MAIL_LOCAL_SEARCH_PROVIDERS=icloud,microsoft`
- `LAB86_MAIL_ENCRYPTION_KEY`
- `OPENROUTER_API_KEY` or another supported platform AI key
- `LAB86_MAIL_OPENAI_MODEL`
- `LAB86_MAIL_OPENAI_FAST_MODEL`
- `CLERK_PRO_PLAN_SLUG=mail_pro`
- `CLERK_PRO_AI_FEATURE_SLUG=b2c_mail`
- `LAB86_AI_FREE_MONTHLY_CREDITS=0`
- `LAB86_AI_PRO_MONTHLY_CREDITS=500`

Development-only:

- `STAGING_BASIC_AUTH_USER`
- `STAGING_BASIC_AUTH_PASSWORD`

Emergency switches:

- `LAB86_DISABLE_LAB86_AI=1`
- `LAB86_DISABLE_OUTBOUND_SEND=1`
- `LAB86_DISABLE_PUBLIC_SIGNUP=1`
- `LAB86_MAIL_CORPUS_RECONCILE_ENABLED=0`
- `LAB86_MAIL_LOCAL_SEARCH_DISABLED_PROVIDERS=icloud,microsoft,google`

## DNS Cutover

Use Railway-provided domains until the final cutover:

- Development: `https://web-development-292e.up.railway.app`
- Production: `https://web-production-3ec2.up.railway.app`

Before changing records, lower TTL and record current values:

```bash
dig +short mail.lab86.io
dig +short mail-staging.lab86.io
```

Current Cloudflare state after cleanup on June 4, 2026:

- `mail.lab86.io` -> no DNS record
- `mail-staging.lab86.io` -> no DNS record

Rollback values removed on June 4, 2026:

- `mail.lab86.io` A -> `100.104.121.93`, DNS-only, TTL automatic
- `mail.lab86.io` AAAA -> `fd7a:115c:a1e0::9c35:795d`, DNS-only, TTL automatic

Add custom domains in Railway first:

```bash
railway domain mail-staging.lab86.io --service web --environment development --json
railway domain mail.lab86.io --service web --environment production --json
```

Then update Cloudflare records to the Railway-provided targets.

As of June 4, 2026, the Railway CLI can deploy and update variables, but custom domain creation returns
`Unauthorized. Please run railway login again.` Do not cut Cloudflare DNS until the domains appear under the
Railway `web` service.

Verify:

```bash
curl --fail https://mail-staging.lab86.io/api/healthz
curl --fail https://mail.lab86.io/api/healthz
```

## Rollback

Production rollback priority:

1. Roll back to the previous healthy Railway deployment.
2. Verify `https://mail.lab86.io/api/healthz`.
3. If Railway domain/cutover itself is broken, restore the old Cloudflare record recorded before cutover.
4. Open a Git revert or fix-forward PR so `main` reflects the restored production behavior.

Useful Railway commands:

```bash
railway deployment list --service web --environment production --limit 20 --json
railway logs --service web --environment production --lines 200 --json
railway redeploy --service web --environment production --yes
```

## Convex Export / Restore Runbook

Provider mail remains the source of truth for transport, but Convex stores hosted app state and the local mail
corpus used for B2C search: users, connected account metadata, encrypted provider grants, AI settings, AI usage,
entitlements/reporting mirrors, corpus sync state, webhook events, and indexed mail documents.

Before public launch:

1. Run a production export from the Convex dashboard or CLI.
2. Store the export in the Lab86 private backup location.
3. Verify the export contains expected hosted tables.
4. Document the restore target and test restore in a non-production Convex deployment.

Do not restore production data into development unless provider grants and encrypted secrets are explicitly
sanitized.

## Mail Corpus Backfill / Reconcile

Convex is the durable local mail corpus. Nylas is the interim transport used to fetch mail and receive webhook
wake signals.

Manual backfill for one grant-backed account:

```bash
curl --fail -X POST https://mail-staging.lab86.io/api/mail/corpus/backfill \
  -H "Authorization: Bearer $LAB86_CONVEX_INTERNAL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"userId":"user_...","accountId":"grant_...","limit":50}'
```

If the response includes `nextPageToken`, call the endpoint again with that token until `corpusReady` is true.

Reconciliation cron:

```bash
curl --fail -X POST https://mail-staging.lab86.io/api/mail/corpus/reconcile \
  -H "Authorization: Bearer $LAB86_CONVEX_INTERNAL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"limit":10,"messageLimit":50}'
```

The reconciler re-reads recent provider messages for ready accounts and repairs missed webhook delivery. It is safe
to run repeatedly; Convex upserts by `(accountId, providerMessageId)` and `(accountId, providerThreadId)`.

Local-first search rollout is controlled by provider list:

- `LAB86_MAIL_LOCAL_SEARCH_PROVIDERS=icloud,microsoft` is the default rollout state.
- Set `LAB86_MAIL_LOCAL_SEARCH_PROVIDERS=all` to include Google once parity is validated.
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

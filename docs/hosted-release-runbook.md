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

- Development deployment: `jjalangtry:lab86-mail:development`
  - Deployment name: `precise-skunk-847`
  - URL: `https://precise-skunk-847.convex.cloud`
  - Site URL: `https://precise-skunk-847.convex.site`
- Production deployment: `jjalangtry:lab86-mail:production`
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

- Free/default: 25,000 Lab86 AI credits per month
- Pro: $12/month, 2,000,000 Lab86 AI credits per month
- Pro plan slug: `pro`
- Pro feature slug: `ai_credits_2m`

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
- CodeRabbit: install the GitHub App on `Lab86-io/lab86-mail` so PR #1 receives a review.

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
- `LAB86_MAIL_ENCRYPTION_KEY`
- `OPENROUTER_API_KEY` or another supported platform AI key
- `LAB86_MAIL_OPENAI_MODEL`
- `LAB86_MAIL_OPENAI_FAST_MODEL`
- `LAB86_AI_FREE_MONTHLY_CREDITS=25000`
- `LAB86_AI_PRO_MONTHLY_CREDITS=2000000`

Development-only:

- `STAGING_BASIC_AUTH_USER`
- `STAGING_BASIC_AUTH_PASSWORD`

Emergency switches:

- `LAB86_DISABLE_LAB86_AI=1`
- `LAB86_DISABLE_OUTBOUND_SEND=1`
- `LAB86_DISABLE_PUBLIC_SIGNUP=1`
- `LAB86_MAIL_CORPUS_RECONCILE_ENABLED=0`

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

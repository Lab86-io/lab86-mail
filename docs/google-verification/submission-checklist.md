# Submission checklist for the owner

Product: Albatross, from Lab86. Google Cloud project: `lab86-mail-production`
(452431903621). Admin account: `jakob@lab86.io`. Status of this text:
2026-09-29, branch `claude/casa-verify-gaps`.

Do the steps in this order. Each step has a check box. Keep secrets out of
e-mail, chat, Git, and shell history.

## Facts on 2026-09-28

- Brand verification for "Albatross" is done.
- Data-access verification is not started.
- 21 of 100 lifetime users of the unverified app are used.
- From 2026-10-20, Google makes 2-step verification necessary on `jakob@lab86.io`.
- DNS for `lab86.io` is on Cloudflare. `mail.lab86.io` points to Railway.
  `clerk.mail.lab86.io` points to Clerk.

## Step 1: 2-step verification on all admin accounts

Turn on 2-step verification (a passkey or an authenticator app, not SMS, where
the service allows it). Keep the recovery codes in the password manager.

- [ ] Google: `jakob@lab86.io` (necessary from 2026-10-20). Also each other
      Owner or Editor of project 452431903621.
- [ ] Railway (the account that owns project `lab86-mail`).
- [ ] Convex (the team that owns the production deployment).
- [ ] Clerk (dashboard users of the production instance).
- [ ] GitHub (each member of `Lab86-io` with write access).
- [ ] Cloudflare (DNS for `lab86.io`).
- [ ] Apple Developer and App Store Connect (team `5JZV7V6Y4Z`).
- [ ] OpenRouter.
- [ ] Also: Nylas, Resend, Browserbase, and the Stripe account of Clerk Billing.
- [ ] Record the date of each step. CASA requirement 3.3.1 makes MFA necessary on
      admin interfaces (`security-controls.md`, section 3).

## Step 2: finish the casa-prep round

Do not submit before these items are in production. The documents in this
folder describe them as "(after the casa-prep round)".

- [ ] OAuth callbacks bound to the signed-in user.
- [ ] Nonce-based CSP.
- [ ] Key ids on encrypted secrets.
- [ ] Disconnect deletes the content index too.
- [ ] OpenRouter `data_collection: deny` on all model calls.
- [ ] Attachment files in Convex file storage (60 days, 25 MB maximum,
      deleted on disconnect).
- [ ] Google accounts talk to Gmail, Calendar, and People APIs directly.
      Microsoft and iCloud stay on Nylas.
- [ ] Opus brief defects and failed-call cost records.
- [ ] The findings S1 to S12 in `security-controls.md`, section 9, have an
      owner and a plan. Fix each critical and high item before the lab scan.
      Google gives the letter only when critical and high findings are fixed
      (<https://support.google.com/cloud/answer/13463817>).
- [x] `app/privacy/page.tsx` names each service that receives user data or
      the IP address of the user: Browserbase, Apple push, the browser push
      services, the site icon services (DuckDuckGo and Google), Open-Meteo,
      OpenStreetMap Nominatim, Google Maps, the connected tools, and the hosts
      that the browser loads directly (Google Fonts, museum collections,
      DiceBear). Done on 2026-09-29.
- [ ] The disconnect text of `app/privacy/page.tsx` must match
      `retention-and-deletion.md`.
- [x] The sign-in and sign-up pages name Albatross, tell what it does, and
      link Privacy and Terms (`components/auth/AuthScreen.tsx`). Done on
      2026-09-29.
- [x] The Drive OAuth request has no `spreadsheets` and no `presentations`
      scope. Done on 2026-09-29 (`scopes.md`, owner notes 1 and 2).

## Step 3: Google Cloud setup for the direct transport

Run these commands as `jakob@lab86.io`. Replace `<PUSH_PATH>` with the push
route that the Gmail workstream ships. Do not guess the path.

```bash
gcloud config set project lab86-mail-production

# APIs that the direct transport and Drive use.
gcloud services enable gmail.googleapis.com calendar-json.googleapis.com \
  people.googleapis.com drive.googleapis.com docs.googleapis.com \
  sheets.googleapis.com slides.googleapis.com pubsub.googleapis.com

# Topic for Gmail push. Gmail publishes to it as a Google service account.
gcloud pubsub topics create gmail-push
gcloud pubsub topics add-iam-policy-binding gmail-push \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

# Service account whose OIDC token Pub/Sub sends with each push.
gcloud iam service-accounts create gmail-push-invoker \
  --display-name="Gmail push invoker"

# Pub/Sub makes the push token as its service agent. The service agent needs
# the Token Creator role on the invoker service account. 452431903621 is the
# project number. The person who makes the subscription needs the
# iam.serviceAccounts.actAs permission on the invoker (a project owner has it).
gcloud iam service-accounts add-iam-policy-binding \
  gmail-push-invoker@lab86-mail-production.iam.gserviceaccount.com \
  --member="serviceAccount:service-452431903621@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"

# Push subscription to Albatross. The route checks the OIDC token.
gcloud pubsub subscriptions create gmail-push-albatross \
  --topic=gmail-push \
  --push-endpoint="https://mail.lab86.io/<PUSH_PATH>" \
  --push-auth-service-account="gmail-push-invoker@lab86-mail-production.iam.gserviceaccount.com" \
  --push-auth-token-audience="https://mail.lab86.io/<PUSH_PATH>" \
  --ack-deadline=20 \
  --message-retention-duration=1d

# Check the result.
gcloud pubsub topics get-iam-policy gmail-push
gcloud pubsub subscriptions describe gmail-push-albatross
```

- [ ] Put the topic name (`projects/lab86-mail-production/topics/gmail-push`)
      and the expected audience in the Railway variables that the Gmail
      workstream names. Use the Railway dashboard, so the values stay out of
      shell history.
- [ ] Turn on the push route only after you make the subscription. Until then,
      the 2-minute History poll is the sync path.
- [ ] In Google Auth Platform > Clients, check that the OAuth client of the
      mail flow has the redirect URI `https://mail.lab86.io/api/files/oauth/callback`.
- [ ] In Google Auth Platform > Branding, keep `lab86.io` in the authorized
      domains. Keep `nylas.com` while any Google grant still goes through Nylas.
- [ ] After the switch of the Google mailboxes to the direct transport, run
      the Nylas grant cleanup. Do the dry run first. The commands are in
      `docs/google-direct-transport.md`, section "Cleanup". After the cleanup,
      the rollback to Nylas does not work for the cleaned accounts.

## Step 4: staging model key

Staging (Railway environment `development`) must not use the production
OpenRouter key.

- [ ] In OpenRouter, make a new key named `albatross-staging` with a monthly
      credit limit.
- [ ] In the OpenRouter account settings (privacy section), turn off each
      option that lets providers train on inputs or log inputs. This setting
      is for the account. It supports the per-call `data_collection: deny`.
- [ ] In the Railway dashboard, set `OPENROUTER_API_KEY` of service `web` in
      environment `development` to the new key. Redeploy staging.
- [ ] Check that the production key and the staging key differ. Do not print
      either key.

## Step 5: Microsoft publisher verification (free)

This step is for Microsoft accounts. It does not change the Google review.

- [ ] Sign in to Microsoft Partner Center. Get a Microsoft AI Cloud Partner
      Program ID for Lab86 (free).
- [ ] In Microsoft Entra ID > App registrations, open the app that the Nylas
      Microsoft connector uses.
- [ ] Branding & properties: set the publisher domain to `lab86.io`. Add the
      Partner ID. Click "Verify and save".
- [ ] Check that the consent screen for a Microsoft account shows the blue
      "verified" badge.

## Step 6: evidence for the lab

- [ ] Run Qualys SSL Labs on `mail.lab86.io`
      (<https://www.ssllabs.com/ssltest/>). Keep the PDF. The lab must have it
      (CASA 4.1.1 and 4.1.2).
- [ ] Make a dependency scan report after the fixes (`bun audit` and
      OSV-Scanner). Commands are in `security-controls.md`, section 8.
- [ ] Check each DNS record of `lab86.io` in Cloudflare. Delete each record
      that points to a service that you do not use now (CASA 6.4.1).
- [ ] Get a sample of a login log line from Railway, with no token in it
      (CASA 6.5.1).
- [ ] Confirm these vendor settings and record the answer in
      `security-controls.md`: Clerk bot protection and lockout; Clerk session
      lifetime; Convex backup retention; Railway log retention; Browserbase
      recording retention; Resend log retention.

## Step 7: make the test accounts

- [ ] Follow `test-account.md`: the Clerk login, the Google test mailbox, and
      the seed data.

## Step 8: record the demo video

- [ ] Record only after step 2 is in production.
- [ ] Follow `demo-video-script.md`. Show the two consent flows.
- [ ] Upload to YouTube as "Unlisted".

## Step 9: submit Google data-access verification

In the Google Cloud console for project 452431903621:

- [ ] Google Auth Platform > Data Access: add each scope of `scopes.md`,
      section "Summary". Remove any scope that is not in that list.
- [ ] For each sensitive and restricted scope, paste the justification. Use the
      "Feature" and "Narrower scope" text of `scopes.md`.
- [ ] Remove `spreadsheets` and `presentations` from Data Access. Albatross
      does not ask for them now (`scopes.md`, owner note 1).
- [ ] Branding: check the home page, the privacy policy
      (`https://mail.lab86.io/privacy`), and the terms
      (`https://mail.lab86.io/terms`). The home page sends a signed-out
      visitor to `/sign-in`. That page names Albatross, tells what it does,
      and links Privacy and Terms. If the reviewer asks for a home page with
      no redirect, use `https://mail.lab86.io/pricing` or
      `https://mail.lab86.io/sign-in`. The privacy policy must have the
      Limited Use text (`app/privacy/page.tsx:67-92`).
- [ ] Verification Center: paste the YouTube link. Submit.
- [ ] Answer each e-mail from the Google review team within a few days.
      Google estimates about 6 weeks for restricted scopes
      (<https://support.google.com/cloud/answer/13463817>).

## Step 10: CASA assessment with TAC Security

- [ ] Wait for the Google e-mail that starts the security assessment. Google
      sets the level (AL1 or AL2).
- [ ] Only then buy the TAC Security Premium plan at
      <https://casa.tacsecurity.com/>. On 2026-09-28 the site listed Premium
      AL1 at $855 with unlimited revalidation. Check the price and the level
      before you pay.
- [ ] Fill the TAC form with the values in `test-account.md`, section
      "Information for the TAC form".
- [ ] Upload the answers of `security-controls.md` and the evidence of step 6.
- [ ] Give TAC the test login through the TAC portal.
- [ ] Fix each finding of the TAC scan. Ask for the re-scan.
- [ ] TAC sends the letter of validation to Google. Google makes a decision in about
      5 to 6 business days (<https://tacsecurity.com/esof-appsec-ada-casa-faqs/>).
- [ ] Put a reminder 11 months after the letter date. The assessment occurs again
      at 12-month intervals (<https://support.google.com/cloud/answer/13463816>).

## Step 11: after approval

- [ ] Delete or disable the test accounts.
- [ ] Turn bot protection back on in Clerk if you changed it for the scan.
- [ ] Keep the dependency scan in CI (add Dependabot or an OSV-Scanner step).

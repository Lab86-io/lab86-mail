# Google Drive + AI Office operational runbook

Date: 2026-07-27

## Enabled project services

Configured gcloud project: `lab86-mail-production`

Enabled APIs:

- `drive.googleapis.com`
- `docs.googleapis.com`
- `sheets.googleapis.com`
- `slides.googleapis.com`

Verify:

```bash
gcloud services list --enabled \
  --filter='config.name:(drive.googleapis.com docs.googleapis.com sheets.googleapis.com slides.googleapis.com)' \
  --format='value(config.name)'
```

## Google OAuth client

Google requires ordinary Google-user OAuth clients and consent-screen
acknowledgements to be created manually in Google Cloud Console; they cannot be
created programmatically with gcloud. The newer `gcloud iam oauth-clients`
commands manage Workforce/IAM OAuth clients and support only IAM-oriented
scopes, so they are not a substitute for a Drive web client.

In Google Auth Platform for `lab86-mail-production`:

1. Configure the Albatross app identity, support email, audience, and authorized
   domains.
2. Add the Drive, Docs, Sheets, Slides, `openid`, and `email` scopes requested in
   `lib/files/providers.ts`.
3. Reuse the existing **Lab86 Mail** Web application OAuth client. Do not create
   another web client for Files.
4. Preserve its existing callbacks and add both Files callback URIs:

   - `https://mail.lab86.io/api/files/oauth/callback`
   - `https://mail-staging.lab86.io/api/files/oauth/callback`

5. Complete Google verification/security requirements before broad external
   production availability. Testing-mode refresh grants can expire quickly.

The Clerk Google-login client is separate from this Drive client. Do not replace
Clerk's client ID when activating Files.

Official references:

- <https://developers.google.com/identity/protocols/oauth2>
- <https://developers.google.com/identity/protocols/oauth2/resources/best-practices>
- <https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance>

## Railway variables

Set the client credentials separately in the `development` and `production`
environments on the `web` service:

```text
GOOGLE_DRIVE_CLIENT_ID
GOOGLE_DRIVE_CLIENT_SECRET
```

The callback defaults to `LAB86_MAIL_PUBLIC_URL + /api/files/oauth/callback`.
`CLOUD_FILES_REDIRECT_URI` is only needed as an explicit override.

Do not commit or print the client secret. Railway variable writes trigger a
redeploy; verify `/api/files/status` reports Google Drive as configured after the
new deployment is healthy.

## Functional acceptance

1. Connect Google Drive on web and iOS.
2. Browse/search folders and files.
3. Open a native Google Doc, Sheet, or Slides file; confirm it imports only once.
4. Edit inline and confirm autosave advances the Albatross revision.
5. Sync to Google and confirm the original provider file changes.
6. Edit the file directly in Google, then confirm Albatross sync refuses to
   overwrite it.
7. Use **Import latest Google changes**, then sync again.
8. Create a document from a Daily Brief recommendation and confirm the review
   action opens Files.
9. Ask Albatross to find a Drive file, import it, suggest a change, apply it, and
   export `.docx`, `.xlsx`, or `.pptx`.

# Document editor on Railway

Albatross uses a separate Collabora CODE service, with the web app acting as its WOPI storage host. Google originals are exported to private editable DOCX/XLSX/PPTX copies. Save to Google waits for a durable WOPI upload receipt, then conditionally replaces the original Google file without changing its ID. Provider etags prevent overwriting changes made elsewhere.

## Railway service

- Project: `lab86-mail` (`919576b9-789c-4257-b6cc-250cf4a28ecb`)
- Service: `documents` (`1c39c627-c46c-4318-88cc-8f121ecc2e65`), production environment
- Image: `collabora/code@sha256:cd75f5b95a01ec70ab5a1ca540b0b52e9fb0fea2146ca7210cb2488589b7fd6b` (26.04.3.2)
- HTTPS origin: `https://documents-production-9780.up.railway.app`
- Target port and `PORT`: `9980`
- Healthcheck: `/hosting/discovery`, 300-second startup allowance
- `aliasgroup1=https://mail.lab86.io:443`
- `aliasgroup2=https://mail-staging.lab86.io:443`
- `extra_params=--o:ssl.enable=false --o:ssl.termination=true --o:welcome.enable=false --o:security.enable_macros_execution=false --o:logging.level=warning --o:logging.level_startup=warning`

Railway terminates TLS. WOPI storage remains in Convex, so document-server replacement does not remove saved files. CODE uses its upstream chroot and seccomp protections; Railway cannot create its mount namespaces, so it falls back to copying the jail tree. Do not disable seccomp or document-process isolation to avoid those runtime warnings. The upstream CODE welcome screen remains part of this free edition.

## Web environment

Set these separately in each web environment:

```dotenv
OFFICE_EDITOR_PROVIDER=collabora
OFFICE_EDITOR_ENABLED=true
OFFICE_DOCUMENT_SERVER_URL=https://documents-production-9780.up.railway.app
OFFICE_APP_ORIGIN=https://mail-staging.lab86.io
OFFICE_JWT_SECRET=<unique random secret of at least 32 characters>
```

Use `https://mail.lab86.io` as the production app origin. Do not reuse signing secrets across environments. `OFFICE_LICENSE_ACCEPTED` applies only to the existing ONLYOFFICE adapter; it is not needed for Collabora. Never put secrets in source control or browser configuration. Deploy the Convex schema/functions before the web app. Railway production uses `https://proficient-viper-594.convex.cloud`; development uses `https://precise-skunk-847.convex.cloud`. Confirm the target against that environment’s `NEXT_PUBLIC_CONVEX_URL` before deploying. The Convex CLI’s default production selection currently resolves to a different deployment, so use deployment-specific credentials and verify the printed URL.

Only the exact WOPI file and contents routes bypass interactive authentication. Each validates an expiring, owner/document/session-bound capability. Other Office routes require the signed-in user. Locks serialize document-server writes; conflicting saves are retained as recovery versions. Google credentials and encrypted source-version sessions never enter editor configuration.

The iframe posts its access token in a form body. Save includes a unique receipt ID in Collabora's `ExtendedData`; WOPI stores it atomically with the revision. The UI polls for that receipt before allowing Google replacement. Google opening retries up to three exports if conversion changes the source version; continued changes produce a retryable error. Google saving uses a version check plus Drive v2 `If-Match` conditional media conversion. It never silently retries a conflicting write.

## Verification

Run focused tests with `bun test tests/chat-document-dogfood.test.ts tests/office-documents-convex-runtime.test.ts tests/documents-services.test.ts tests/proxy-basic-auth.test.ts`.

The live verification scripts use synthetic data and a private development `.env.local`. `scripts/prepare-collabora-verification.ts` creates isolated Office copies under an `office-verification-` owner and writes expiring sessions to `/tmp/chat-doc-collabora-sessions.json`. `scripts/verify-collabora-live.ts` opens the actual iframe component, types changes, saves them through the deployed WOPI endpoint and inspects the stored Office archive. Run with Bun and installed Playwright Chromium. Clean up that exact synthetic owner using `accounts.deleteUserCascade` after verification.

`scripts/verify-google-working-copy-live.ts` expects an owner/connection selection in private `/tmp/chat-doc-google-connections.json`. It creates synthetic Docs/Sheets/Slides, verifies save/reopen and stale-version refusal, and moves only those newly created files to Trash. It never edits an existing user file.

Google↔Office conversion can alter provider-specific features. The original identity and sharing stay in Google, and Albatross retains working-copy versions for recovery; these are not a claim of lossless conversion of every Google feature.

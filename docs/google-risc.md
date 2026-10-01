# Google Cross-Account Protection (RISC)

Status: 2026-10-01, branch `claude/google-security-consent`.

Google Cross-Account Protection (RISC) tells Albatross about security events
on a Google account that gave access to Albatross. Examples: Google revoked
the tokens, Google locked a hijacked account, or Google tells the user to
change the password. Google sends each event as a signed Security Event Token
(SET) to a receiver URL. Reference:
<https://developers.google.com/identity/protocols/risc>.

## Receiver

- URL: `https://mail.lab86.io/api/google/risc` (`app/api/google/risc/route.ts`).
- Method and body: `POST`, `Content-Type: application/secevent+jwt`, the JWT
  is the body.
- The route is public (`proxy.ts`). Google has no Clerk session. The
  signature check is the authentication.
- Verification (`lib/google/risc.ts`):
  1. Read `https://accounts.google.com/.well-known/risc-configuration`. Keep
     `issuer` and `jwks_uri` for 6 hours. Refuse a configuration with another
     issuer or a key URI that is not HTTPS.
  2. Read the keys at `jwks_uri`. Keep them for the `max-age` of the answer
     (5 minutes to 24 hours). An unknown key id loads the keys again, at most
     one time each minute.
  3. Check the RS256 signature.
  4. Check `iss`. It must be `https://accounts.google.com`. A trailing slash
     is permitted: the configuration has none, and Google's tokens have one.
  5. Check `aud`. It must be one of our OAuth client ids.
  6. Check `iat`. It must be in the last 7 days, and not more than 5 minutes
     in the future. Google says not to check `exp`.
  7. Check `jti` and `events`.
- Answers (RFC 8935):
  - `202` with no body: the token is correct. A second delivery of the same
    `jti` also gets `202`.
  - `400` with `{"err": "...", "description": "..."}`: the token is not
    correct. The codes are `invalid_request`, `invalid_key`,
    `invalid_issuer`, `invalid_audience`, and `authentication_failed`.
  - `503`: Albatross cannot read the Google keys, or cannot write to Convex.
    Google sends the event again.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `LAB86_GOOGLE_RISC` | Not set (off) | `1` lets the events change connections. Not set: Albatross verifies, records, logs, and answers `202`. It changes nothing. |
| `LAB86_GOOGLE_RISC_AUDIENCES` | `GOOGLE_MAIL_CLIENT_ID` and `GOOGLE_DRIVE_CLIENT_ID` | A comma list of the OAuth client ids that `aud` can name. Put all the client ids of the project in this list. A token for another client id gets `400 invalid_audience`. |

## Events and actions

The action applies only with `LAB86_GOOGLE_RISC=1`. Albatross never revokes a
token for these events: Google revoked it already.

| Event type | Action |
|---|---|
| `https://schemas.openid.net/secevent/risc/event-type/sessions-revoked` | Record only. Albatross has no Google sign-in session. A token revoke comes as its own event. |
| `https://schemas.openid.net/secevent/oauth/event-type/tokens-revoked` | Delete the stored tokens. Mark the connection "Reconnect needed". Sync stops. |
| `https://schemas.openid.net/secevent/oauth/event-type/token-revoked` | The same, for the one connection that holds the named refresh token. |
| `https://schemas.openid.net/secevent/risc/event-type/account-disabled` | Reason `hijacking`, or no reason: delete the stored tokens, mark "Reconnect needed", and set a security hold. Reason `bulk-account`: record only. |
| `https://schemas.openid.net/secevent/risc/event-type/account-enabled` | Clear the security hold. The tokens are gone, so the user must reconnect. |
| `https://schemas.openid.net/secevent/risc/event-type/account-credential-change-required` | Mark "Reconnect needed". The tokens stay. |
| `https://schemas.openid.net/secevent/risc/event-type/verification` | Record only. The log shows the `state`. |

A new sign-in (mail reconnect or Drive connect) clears the hold and the event
mark. The user sees one of these texts on the connection
(`convex/googleSecurity.ts`, `SECURITY_REASONS`):

- "Reconnect needed: Google stopped the access to this account. Reconnect it
  to use it again."
- "Reconnect needed: Google locked this account because of a risk. Reconnect
  it after Google unlocks the account."
- "Reconnect needed: Google unlocked this account. Reconnect it to use it
  again."
- "Reconnect needed: Google tells you to change the password of this account.
  Change it, then reconnect the account."

## How an event finds a connection

`convex/googleSecurity.ts` (`recordSecurityEvent`) looks in two places:

- Direct Google mail grants (`providerGrants` rows with a `google:` grant id).
  A Nylas account has no Google tokens at Albatross, so no event changes it.
- Google Drive connections (`cloudFileConnections` and
  `cloudFileCredentials`).

The subject of the event gives the key:

- `sub` (the Google account id). The mail sign-in stores it from the
  userinfo answer (or the ID token). The Drive connect stores the userinfo
  `id`, which is the same id. Grants from before this change get it later:
  - Mail: on the next token refresh, from the ID token, else from userinfo
    (`lib/google/tokens.ts`). An active mailbox refreshes each hour.
  - Drive: on the next token refresh (`cloudFiles.updateCredentials`), or
    with the one-time backfill below.
- `email`, only when the event has no `sub`. An address can move to another
  Google account; a `sub` cannot.
- A refresh token identifier, for `token-revoked`. Google sends the first 16
  characters (`prefix`) or a double SHA-512 hash
  (`hash_base64_sha512_sha512`). Albatross keeps a SHA-256 of the prefix and
  the double hash (`lib/google/token-identifiers.ts`), never the token. The
  sign-in stores them, and each refresh stores them again. Google does not
  say if the inner hash is of raw bytes or of text. Albatross uses raw bytes.
  An event that matches nothing is recorded with 0 matches; the next refresh
  then fails with `invalid_grant` and marks the connection, as before.

## Records and retention

- `googleSecurityEvents`: one row for each `jti`. The row has the event
  names, the time, the mode (`applied` or `logged`), and the number of
  matches. It has no subject data.
- `googleSecurityAudit`: one row for each change on one connection: the user
  id, the account id or connection id, the event name, and the action.
  Account deletion deletes these rows.
- A daily cron (`google security event sweep`) deletes rows older than 30
  days.
- The log line `[google-risc] event` has the `jti`, the event names, the mode,
  and the counts. It has no subject data.

## Register the RISC stream (owner, one time)

Do these steps in Cloud Shell for the project `lab86-mail-production`
(project number `452431903621`). Do them after this change is in production.

Before you start:

- The receiver domain must be an authorized domain of the OAuth consent
  screen. `lab86.io` must be in the list. If it is not, `stream:update`
  returns `403` "The delivery endpoint does not belong to any of your
  project's domains".
- Read the RISC Terms on
  <https://console.cloud.google.com/apis/library/risc.googleapis.com?project=lab86-mail-production>.
  Enable the API only if you accept them.

### 1. Set the names

```bash
PROJECT_ID=lab86-mail-production
SA_NAME=albatross-risc
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
RECEIVER=https://mail.lab86.io/api/google/risc
ME="$(gcloud config get-value account)"
gcloud config set project "$PROJECT_ID"
```

### 2. Enable the RISC API

```bash
gcloud services enable risc.googleapis.com --project="$PROJECT_ID"
```

If this command fails because of the terms, click "Enable" on the console
page above, then go to step 3.

### 3. Make the service account and give it the RISC role

```bash
gcloud iam service-accounts create "$SA_NAME" \
  --project="$PROJECT_ID" \
  --display-name="Albatross RISC stream admin"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/riscconfigs.admin" \
  --condition=None
```

### 4. Let your user act as the service account

Impersonation needs the Service Account Token Creator role for your user on
the service account. No key file is necessary.

```bash
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project="$PROJECT_ID" \
  --member="user:${ME}" \
  --role="roles/iam.serviceAccountTokenCreator"
```

An IAM change can take up to 2 minutes. If the next step returns `403`
(`iam.serviceAccounts.getAccessToken` denied), wait, then do it again.

### 5. Get a token

Path A, an access token by impersonation:

```bash
TOKEN="$(gcloud auth print-access-token --impersonate-service-account="$SA_EMAIL")"
```

If a RISC call with this token returns `401` or `403` "insufficient
authentication scopes", use path B. Path B is the signed JWT that Google
documents for the RISC API. It uses the same Token Creator role.

```bash
NOW="$(date +%s)"
cat > /tmp/risc-claims.json <<EOF
{"iss":"${SA_EMAIL}","sub":"${SA_EMAIL}","aud":"https://risc.googleapis.com/google.identity.risc.v1beta.RiscManagementService","iat":${NOW},"exp":$((NOW + 3600))}
EOF
gcloud iam service-accounts sign-jwt /tmp/risc-claims.json /tmp/risc.jwt --iam-account="$SA_EMAIL"
TOKEN="$(cat /tmp/risc.jwt)"
rm -f /tmp/risc-claims.json
```

A token is good for 1 hour. Do not paste it in a chat or a file.

### 6. Register the receiver and the events

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST "https://risc.googleapis.com/v1beta/stream:update" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"delivery\": {
      \"delivery_method\": \"https://schemas.openid.net/secevent/risc/delivery-method/push\",
      \"url\": \"${RECEIVER}\"
    },
    \"events_requested\": [
      \"https://schemas.openid.net/secevent/risc/event-type/sessions-revoked\",
      \"https://schemas.openid.net/secevent/oauth/event-type/tokens-revoked\",
      \"https://schemas.openid.net/secevent/oauth/event-type/token-revoked\",
      \"https://schemas.openid.net/secevent/risc/event-type/account-disabled\",
      \"https://schemas.openid.net/secevent/risc/event-type/account-enabled\",
      \"https://schemas.openid.net/secevent/risc/event-type/account-credential-change-required\",
      \"https://schemas.openid.net/secevent/risc/event-type/verification\"
    ]
  }"
```

The answer must be `HTTP 200`. Read the stream back:

```bash
curl -sS -w '\nHTTP %{http_code}\n' "https://risc.googleapis.com/v1beta/stream" \
  -H "Authorization: Bearer ${TOKEN}"
```

### 7. Send a verification event

```bash
STATE="albatross-risc-check-$(date +%Y%m%d%H%M)"
curl -sS -w '\nHTTP %{http_code}\n' -X POST "https://risc.googleapis.com/v1beta/stream:verify" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"state\": \"${STATE}\"}"
echo "$STATE"
```

The answer must be `HTTP 200`. In the Railway production logs, find the line
`[google-risc] event` with `verification state=<STATE>`. It can take a few
minutes. A line `[google-risc] refused a token invalid_audience` means that
the token names a client id that is not in `LAB86_GOOGLE_RISC_AUDIENCES`. Add
the client ids of the project to that variable, then send the event again.

### 8. Turn on the actions

When the verification line is in the log, set `LAB86_GOOGLE_RISC=1` on the
Railway production service. Do not print the other variables.

### 9. Fill the Drive account ids (optional)

Drive connections from before this change get `googleSub` on their next
token refresh. To fill all of them now, run the one-time backfill. Do a dry
run first:

```bash
CONVEX_DEPLOYMENT=prod:proficient-viper-594 npx convex run googleSecurity:backfillDriveGoogleSub '{"dryRun": true}'
CONVEX_DEPLOYMENT=prod:proficient-viper-594 npx convex run googleSecurity:backfillDriveGoogleSub '{}'
```

### 10. Remove the impersonation right (optional)

```bash
gcloud iam service-accounts remove-iam-policy-binding "$SA_EMAIL" \
  --project="$PROJECT_ID" \
  --member="user:${ME}" \
  --role="roles/iam.serviceAccountTokenCreator"
```

To stop the stream later, send `{"status": "disabled"}` to
`POST https://risc.googleapis.com/v1beta/stream/status:update`.

## Consent rules that go with this change

- The mail and Drive authorization URLs send `include_granted_scopes=true`
  (incremental authorization). The scope lists do not change. A shared OAuth
  client then gives one token the access of the two features. A revoke
  already ends both (`lib/google/shared-grant.ts`). This reverses commit
  `faf5667d` of 2026-07-27, which removed the parameter from the Drive URL.
- Google Drive: a consent without `drive.readonly` is refused, and nothing is
  stored. Without `drive.file` or `documents` the connection is made; Files
  shows "Reconnect Google Drive to let Albatross ...", and "Publish to Google"
  and the Doc save refuse with the same text (`lib/files/drive-capabilities.ts`).
- Mail: a consent without Calendar connects. The calendar surface says
  "No calendar access" and gives a reconnect link that names the account
  (`lib/calendar/sync-copy.ts`).

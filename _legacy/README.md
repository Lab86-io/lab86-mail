# lab86-mail

Local desktop web client for Jakob's hybrid mail setup.

lab86-mail is intentionally tokenless: Google access stays in GOG, and this service calls
`/home/jjalangtry/.local/bin/lab86-gog` for Gmail search, message rendering, and replies.

The UI follows a Gmail-style workflow:

- Left rail for Compose and mailbox/search shortcuts.
- Top AI chat for questions about the selected email or current mailbox.
- Message toolbar for archive, read/unread, trash, summarize, triage, draft, copy, and send.
- Compose modal for new outbound mail.

## Accounts

- `jakob@lab86.io`: primary Google Workspace mailbox for forwarded/imported mail from iCloud and side Gmail accounts.
- `jjalangtry@gmail.com`: direct account for original-account access and replies.
- Any future Gmail/Workspace account can be added with `scripts/auth-google.sh <email>`.

## Run

```bash
cd /home/jjalangtry/services/lab86-mail
npm start
```

Open `http://127.0.0.1:18836/`.

Tailnet URL:

`https://mail.lab86.io/`

`mail.lab86.io` resolves to lab86's Tailscale IPs and is served by Caddy, not
Cloudflare Tunnel.

## Google Auth

Use GOG's remote flow:

```bash
/home/jjalangtry/services/lab86-mail/scripts/auth-google-link.sh jakob@lab86.io
/home/jjalangtry/services/lab86-mail/scripts/finish-google-auth.sh jakob@lab86.io
```

The first script prints the Google sign-in URL using the `jjalangtry-gmail`
OAuth client by default. After approval, pass the returned redirect URL to the
second script. Do not put callback URLs or OAuth codes into notes or chat logs.

## AI

The summarize, triage, and draft buttons use local device agents first:

- `MAIL_OS_AGENT_ENGINE=auto`: prefer Claude if available, then Codex.
- `MAIL_OS_AGENT_ENGINE=claude`: use `claude --print` with tools disabled.
- `MAIL_OS_AGENT_ENGINE=codex`: use `codex exec` in read-only mode.
- `MAIL_OS_AGENT_ENGINE=local`: deterministic fallback only.

If both local agents fail and `/home/jjalangtry/.config/lab86-mail/lab86-mail.env`
defines `OPENAI_API_KEY` and `OPENAI_MODEL`, lab86-mail can fall back to OpenAI.
Send still requires explicit browser confirmation.

## Service

The user service is `lab86-mail.service`.

```bash
systemctl --user status lab86-mail.service
```

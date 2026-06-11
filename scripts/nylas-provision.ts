#!/usr/bin/env bun
/**
 * Nylas application provisioning + status check.
 *
 * Wires a Nylas v3 application for hosted mail: verifies the app environment,
 * registers the OAuth callback, creates the webhook destination, and (when
 * BYO OAuth credentials are supplied) creates the Google/Microsoft connectors.
 * iCloud/IMAP need no connector credentials.
 *
 * Usage:
 *   # Read-only audit of whatever NYLAS_API_KEY points at:
 *   NYLAS_API_KEY=nyk_... bun scripts/nylas-provision.ts status
 *
 *   # Idempotent setup against the PRODUCTION app (run once it exists):
 *   NYLAS_API_KEY=nyk_...prod \
 *   PUBLIC_URL=https://mail.lab86.io \
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
 *   MICROSOFT_CLIENT_ID=... MICROSOFT_CLIENT_SECRET=... \
 *   bun scripts/nylas-provision.ts setup
 *
 * This script ONLY touches the Nylas app it is given a key for. It never reads
 * Railway or rotates secrets — do the env cutover separately after `status`
 * confirms the app is in the `production` environment with connectors live.
 */

const API_KEY = process.env.NYLAS_API_KEY || '';
const API_URI = process.env.NYLAS_API_URI || 'https://api.us.nylas.com';
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://mail.lab86.io').replace(/\/$/, '');
const CALLBACK_URI = `${PUBLIC_URL}/api/nylas/callback`;
const WEBHOOK_URI = `${PUBLIC_URL}/api/nylas/webhook`;

// The corpus webhook handler is generic; subscribe to message lifecycle (for
// incremental sync) and grant lifecycle (for disconnect/expiry cleanup).
const WEBHOOK_TRIGGERS = [
  'message.created',
  'message.updated',
  'message.opened',
  'grant.created',
  'grant.updated',
  'grant.deleted',
  'grant.expired',
];

if (!API_KEY) {
  console.error('Set NYLAS_API_KEY (the key for the target Nylas application).');
  process.exit(1);
}

const mode = process.argv[2] === 'setup' ? 'setup' : 'status';

async function nylas(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API_URI}/v3${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${init.method || 'GET'} ${path} → ${res.status}: ${JSON.stringify(body)}`);
  }
  return body?.data ?? body;
}

async function getApplication() {
  return await nylas('/applications');
}

async function ensureCallback(app: any) {
  const uris: any[] = app.callback_uris || [];
  if (uris.some((u) => u.url === CALLBACK_URI)) return 'present';
  await nylas('/applications', {
    method: 'PATCH',
    body: JSON.stringify({
      callback_uris: [
        ...uris.map((u) => ({ url: u.url, platform: u.platform || 'web' })),
        { url: CALLBACK_URI, platform: 'web' },
      ],
    }),
  });
  return 'created';
}

async function ensureWebhook() {
  const existing: any[] = (await nylas('/webhooks')) || [];
  const match = existing.find((w) => w.webhook_url === WEBHOOK_URI);
  if (match) return { state: 'present', id: match.id };
  const created = await nylas('/webhooks', {
    method: 'POST',
    body: JSON.stringify({
      webhook_url: WEBHOOK_URI,
      trigger_types: WEBHOOK_TRIGGERS,
      description: 'lab86-mail corpus sync',
      notification_email_addresses: [],
    }),
  });
  // Nylas returns the signing secret ONCE on creation — surface it so it can
  // be stored as NYLAS_WEBHOOK_SECRET in Railway.
  return { state: 'created', id: created.id, webhookSecret: created.webhook_secret };
}

async function ensureConnector(provider: 'google' | 'microsoft', clientId: string, clientSecret: string) {
  const existing: any[] = (await nylas('/connectors')) || [];
  if (existing.some((c) => c.provider === provider)) return 'present';
  await nylas('/connectors', {
    method: 'POST',
    body: JSON.stringify({
      provider,
      settings: { client_id: clientId, client_secret: clientSecret },
      // Scopes are requested per-auth by the app; connector-level scopes are
      // the upper bound. Keep these aligned with NYLAS_SCOPES_* in Railway.
      scope:
        provider === 'google'
          ? ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/userinfo.email']
          : ['Mail.ReadWrite', 'Mail.Send', 'offline_access', 'User.Read'],
    }),
  });
  return 'created';
}

async function ensureIcloudConnector() {
  const existing: any[] = (await nylas('/connectors')) || [];
  if (existing.some((c) => c.provider === 'icloud')) return 'present';
  await nylas('/connectors', { method: 'POST', body: JSON.stringify({ provider: 'icloud' }) });
  return 'created';
}

async function listGrants() {
  const data = (await nylas('/grants?limit=200')) || [];
  return Array.isArray(data) ? data : [];
}

async function main() {
  const app = await getApplication();
  const connectors: any[] = (await nylas('/connectors').catch(() => [])) || [];
  const webhooks: any[] = (await nylas('/webhooks').catch(() => [])) || [];
  const grants = await listGrants();

  console.log('Application:');
  console.log(`  name:        ${app.branding?.name}`);
  console.log(`  id:          ${app.application_id}`);
  console.log(
    `  environment: ${app.environment}${app.environment === 'sandbox' ? '  ⚠️  CAPPED AT 5 GRANTS' : ''}`,
  );
  console.log(`  region:      ${app.region}`);
  console.log(`  callbacks:   ${(app.callback_uris || []).map((u: any) => u.url).join(', ') || '(none)'}`);
  console.log(`  connectors:  ${connectors.map((c) => c.provider).join(', ') || '(none)'}`);
  console.log(`  webhooks:    ${webhooks.map((w) => w.webhook_url).join(', ') || '(none)'}`);
  console.log(`  grants:      ${grants.length}`);
  for (const g of grants) console.log(`    - ${g.provider} ${g.email} (${g.grant_status})`);

  if (mode === 'status') {
    if (app.environment === 'sandbox') {
      console.log(
        '\nThis app is in SANDBOX. Convert it to a production app in the Nylas dashboard\n(paid plan) before running `setup` — production has no 5-grant cap.',
      );
    }
    return;
  }

  console.log('\nRunning setup…');
  console.log(`  callback ${CALLBACK_URI}: ${await ensureCallback(app)}`);

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    console.log(
      `  google connector: ${await ensureConnector('google', process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET)}`,
    );
  } else {
    console.log('  google connector: skipped (set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)');
  }
  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
    console.log(
      `  microsoft connector: ${await ensureConnector('microsoft', process.env.MICROSOFT_CLIENT_ID, process.env.MICROSOFT_CLIENT_SECRET)}`,
    );
  } else {
    console.log('  microsoft connector: skipped (set MICROSOFT_CLIENT_ID/MICROSOFT_CLIENT_SECRET)');
  }
  if (process.env.SETUP_ICLOUD === '1') {
    console.log(`  icloud connector: ${await ensureIcloudConnector()}`);
  }

  const webhook = await ensureWebhook();
  console.log(`  webhook ${WEBHOOK_URI}: ${webhook.state} (id ${webhook.id})`);
  if (webhook.webhookSecret) {
    console.log(`\n  >>> Set this in Railway production: NYLAS_WEBHOOK_SECRET=${webhook.webhookSecret}`);
  }
  console.log('\nDone. Verify with: bun scripts/nylas-provision.ts status');
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});

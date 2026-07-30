import { createHmac, timingSafeEqual } from 'node:crypto';

// The AutoFill extension has to tell the server a code was used, so the mail
// that carried it can be filed. It cannot carry the user's real session: Clerk
// does not run there, and sharing the session keychain across the app group
// would hand a short-lived UI extension a fully privileged credential.
//
// Instead the app hands the extension a token that authorises exactly one
// thing — consuming a one-time code for one user, for a few minutes. If it
// leaks it cannot read mail, cannot send mail, and expires on its own.

const TOKEN_TTL_MS = 30 * 60_000;
const TOKEN_VERSION = 'v1';

function secret() {
  // Falls back to the notification link secret so this works on deployments
  // that predate the dedicated variable. Absent both, no token is issued and
  // cleanup falls back to the app doing it on next launch.
  return process.env.LAB86_OTP_CONSUME_SECRET || process.env.LAB86_NOTIFICATION_LINK_SECRET || '';
}

function sign(payload: string, key: string) {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

/**
 * Issues a consume-scoped token, or null when no signing secret is configured.
 */
export function issueConsumeToken(userId: string, now = Date.now()): string | null {
  const key = secret();
  if (!key || !userId) return null;
  const expiresAt = now + TOKEN_TTL_MS;
  // base64url rather than percent-encoding: the token is dot-delimited, and
  // percent-encoding leaves dots in the user id untouched, which would split
  // the token into the wrong number of parts.
  const payload = `${TOKEN_VERSION}.${Buffer.from(userId, 'utf8').toString('base64url')}.${expiresAt}`;
  return `${payload}.${sign(payload, key)}`;
}

export interface ConsumeTokenVerification {
  ok: boolean;
  userId?: string;
  reason?: 'not_configured' | 'malformed' | 'bad_signature' | 'expired';
}

export function verifyConsumeToken(token: string, now = Date.now()): ConsumeTokenVerification {
  const key = secret();
  if (!key) return { ok: false, reason: 'not_configured' };
  const parts = String(token || '').split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return { ok: false, reason: 'malformed' };
  const [, encodedUserId, rawExpiry, providedSignature] = parts;
  const payload = `${TOKEN_VERSION}.${encodedUserId}.${rawExpiry}`;
  const expected = Buffer.from(sign(payload, key), 'utf8');
  const provided = Buffer.from(providedSignature, 'utf8');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'bad_signature' };
  }
  // Expiry is checked only after the signature, so an attacker cannot learn
  // anything from how a forged token fails.
  const expiresAt = Number(rawExpiry);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { ok: false, reason: 'expired' };
  const userId = Buffer.from(encodedUserId, 'base64url').toString('utf8');
  if (!userId) return { ok: false, reason: 'malformed' };
  return { ok: true, userId };
}

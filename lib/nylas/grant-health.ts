import { api, convexMutation } from '@/lib/hosted/convex';
import { nylasErrorStatus } from './retry';

// One account health state for mail and calendar (SYNC-2, CAL-8). A grant
// that Nylas reports as expired, deleted, or unauthorized puts the connected
// account in `status: 'error'` with a reconnect reason. Every sync path skips
// non-connected accounts, so the attempts stop, and the Rail and Settings show
// "Reconnect needed". A successful OAuth reconnect sets `connected` again.

export const RECONNECT_REASON_PREFIX = 'Reconnect needed';

function errorText(err: any): string {
  const parts = [
    err?.message,
    err?.type,
    err?.error,
    err?.errorDescription,
    typeof err?.providerError === 'string' ? err.providerError : JSON.stringify(err?.providerError ?? ''),
  ];
  return parts.filter(Boolean).join(' ');
}

/**
 * True when the error says the grant itself is gone or no longer valid, not
 * that one resource is missing. A 404 counts only when it names the grant, and
 * a 401 only when it names the grant or its credentials, so a bad API key
 * never marks every mailbox for reconnection.
 */
export function isGrantGoneError(err: unknown): boolean {
  const e = err as any;
  const text = errorText(e);
  if (/invalid_grant|no grant found/i.test(text)) return true;
  const status = nylasErrorStatus(e);
  if (status === 404) return /\bgrant\b/i.test(text);
  if (status === 401) {
    return /\bgrant\b|expired|revoked|re-?authenticat|credentials|refresh token/i.test(text);
  }
  return false;
}

export function reconnectReason(detail: string) {
  return `${RECONNECT_REASON_PREFIX}: ${detail}`;
}

export function isReconnectReason(error: unknown) {
  return typeof error === 'string' && error.startsWith(RECONNECT_REASON_PREFIX);
}

type Mutate = typeof convexMutation;

/** Put every account on this grant in the reconnect state. Best effort. */
export async function markGrantNeedsReconnect(
  grantId: string | undefined,
  detail: string,
  mutate: Mutate = convexMutation,
): Promise<boolean> {
  if (!grantId) return false;
  try {
    const result = await mutate<{ updated: number }>(api.accounts.markGrantReconnectNeeded, {
      grantId,
      reason: reconnectReason(detail),
    });
    return Boolean(result?.updated);
  } catch (err: any) {
    console.warn('[grant-health] could not mark grant for reconnect', err?.message || err);
    return false;
  }
}

/**
 * When `err` means the grant is gone, mark it and return true. Callers still
 * rethrow or record the original error.
 */
export async function noteGrantFailure(
  grantId: string | undefined,
  err: unknown,
  mutate: Mutate = convexMutation,
): Promise<boolean> {
  if (!isGrantGoneError(err)) return false;
  const status = nylasErrorStatus(err as any);
  const detail = status === 404 ? 'the mailbox connection was removed' : 'the mailbox sign-in expired';
  await markGrantNeedsReconnect(grantId, detail, mutate);
  return true;
}

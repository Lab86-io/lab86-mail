import { secureKeyring } from './crypto';

// The secure store is off unless LAB86_SECURE_STORE turns it on: "all", or a
// comma list of user ids (a dark launch for the owner first). It also needs
// the secure KEK (lib/secure/crypto.ts): without a key, nothing can be sealed.

/** True when the flag names this user (or all users). The key is not checked here. */
export function secureStoreFlagFor(userId: string, raw = process.env.LAB86_SECURE_STORE): boolean {
  const value = String(raw || '').trim();
  if (!value || !userId) return false;
  if (value.toLowerCase() === 'all') return true;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .includes(userId);
}

/** True when the store works for this user: the flag is on and a key is set. */
export function secureStoreEnabledFor(userId: string): boolean {
  if (!secureStoreFlagFor(userId)) return false;
  try {
    return Boolean(secureKeyring());
  } catch {
    // A bad key turns the store off instead of failing every request.
    return false;
  }
}

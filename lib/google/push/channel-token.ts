// Direct Google push: the secret token of a Calendar or Drive channel.
//
// Google sends the token back in X-Goog-Channel-Token with each message.
// The token is random (32 bytes), and Convex stores only its SHA-256 hash.
// The check compares the hashes in constant time.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Google allows at most 256 characters; 32 random bytes in base64url are 43. */
export function newChannelToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashChannelToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** True when the token has the stored hash. */
export function channelTokenMatches(
  token: string | null | undefined,
  storedHash: string | null | undefined,
): boolean {
  if (!token || !storedHash || !/^[a-f0-9]{64}$/.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(hashChannelToken(token), 'hex'), Buffer.from(storedHash, 'hex'));
}

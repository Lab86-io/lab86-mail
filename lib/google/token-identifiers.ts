// The two identifiers by which a Google Cross-Account Protection
// `token-revoked` event names one refresh token (lib/google/risc.ts). Google
// documents `prefix` (the first 16 characters) and
// `hash_base64_sha512_sha512` (the double SHA-512 hash, base64). Albatross
// keeps neither form of the token itself: it keeps a SHA-256 of the prefix,
// and the double hash without padding. No identifier gives the token back.

import { createHash } from 'node:crypto';

/** Standard base64 with no padding, so a base64url or padded value compares equal. */
export function normalizeBase64(value: string): string {
  return value.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
}

export function sha256Hex(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The identifier of a `prefix` event token: the SHA-256 of its first 16 characters. */
export function refreshTokenPrefixHash(tokenOrPrefix: string) {
  return sha256Hex(tokenOrPrefix.slice(0, 16));
}

export function refreshTokenIdentifiers(refreshToken: string | undefined | null): {
  refreshTokenPrefixHash?: string;
  refreshTokenDoubleHash?: string;
} {
  const token = String(refreshToken || '');
  if (!token) return {};
  const inner = createHash('sha512').update(token, 'utf8').digest();
  return {
    refreshTokenPrefixHash: refreshTokenPrefixHash(token),
    refreshTokenDoubleHash: normalizeBase64(createHash('sha512').update(inner).digest('base64')),
  };
}

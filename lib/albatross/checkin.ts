/** Server-to-Convex caller identity for authenticated check-in routes. */
export function checkinCallerArgs(userId: string) {
  const normalized = userId.trim();
  if (!normalized) throw new Error('userId is required.');
  return { userId: normalized };
}

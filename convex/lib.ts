export function requireInternalSecret(secret?: string) {
  const expected = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  if (expected && secret !== expected) {
    throw new Error('Invalid Convex internal secret.');
  }
}

export function now() {
  return Date.now();
}

export function accountId(userId: string, email: string) {
  return `${userId}:${email.toLowerCase()}`;
}

export function currentPeriod(ts = Date.now()) {
  const date = new Date(ts);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

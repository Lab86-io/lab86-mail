/**
 * "Not related" on a mail proof offer. The dismissal is kept for each Work
 * and thread pair on this device, so the same offer does not come back each
 * time the thread opens. A new Work that matches the thread still shows.
 */
export const PROOF_DISMISSALS_KEY = 'lab86:proof-offer-dismissals';
const LIMIT = 500;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): StorageLike | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export function proofPairKey(accountId: string, threadId: string, workId: string) {
  return `${accountId}\u0000${threadId}\u0000${workId}`;
}

function read(store: StorageLike | null): string[] {
  try {
    const parsed = JSON.parse(store?.getItem(PROOF_DISMISSALS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

export function dismissProofMatches(
  accountId: string,
  threadId: string,
  workIds: string[],
  store: StorageLike | null = storage(),
) {
  const keys = read(store);
  for (const workId of workIds) {
    const key = proofPairKey(accountId, threadId, workId);
    if (!keys.includes(key)) keys.push(key);
  }
  try {
    // Keep the newest pairs; old threads rarely reopen.
    store?.setItem(PROOF_DISMISSALS_KEY, JSON.stringify(keys.slice(-LIMIT)));
  } catch {
    // A full or blocked store keeps the dismissal for this view only.
  }
}

export function withoutDismissedProofMatches<T extends { workId: string }>(
  accountId: string,
  threadId: string,
  matches: T[],
  store: StorageLike | null = storage(),
): T[] {
  const keys = new Set(read(store));
  return matches.filter((match) => !keys.has(proofPairKey(accountId, threadId, match.workId)));
}

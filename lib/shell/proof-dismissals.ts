/**
 * "Not related" on a mail proof offer. The dismissal is kept on the server
 * for each Work and thread pair (/api/albatross/proof-matches/dismissals),
 * and the proof-match route leaves those pairs out on every device. A new
 * Work that matches the thread still shows.
 *
 * An earlier version kept the pairs only in device storage. The first load
 * moves them to the server. A save that fails goes to device storage and
 * moves on the next load.
 */
export const PROOF_DISMISSALS_KEY = 'lab86:proof-offer-dismissals';
const DEVICE_LIMIT = 500;
const BATCH = 100;
const ENDPOINT = '/api/albatross/proof-matches/dismissals';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

interface DismissalPair {
  accountId: string;
  providerThreadId: string;
  workId: string;
}

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

function rememberOnDevice(pairs: DismissalPair[], store: StorageLike | null) {
  const keys = read(store);
  for (const pair of pairs) {
    const key = proofPairKey(pair.accountId, pair.providerThreadId, pair.workId);
    if (!keys.includes(key)) keys.push(key);
  }
  try {
    // Keep the newest pairs; old threads rarely reopen.
    store?.setItem(PROOF_DISMISSALS_KEY, JSON.stringify(keys.slice(-DEVICE_LIMIT)));
  } catch {
    // A full or blocked store keeps the dismissal for this view only.
  }
}

async function send(pairs: DismissalPair[], fetcher: Fetcher) {
  const response = await fetcher(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dismissals: pairs }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error(body?.error || 'The dismissal could not be saved.');
}

/** Save "Not related" for each Work in the offer. A failed save stays on the device. */
export async function dismissProofMatches(
  accountId: string,
  threadId: string,
  workIds: string[],
  fetcher: Fetcher = fetch,
  store: StorageLike | null = storage(),
) {
  const pairs = workIds.map((workId) => ({ accountId, providerThreadId: threadId, workId }));
  if (!pairs.length) return;
  try {
    for (let start = 0; start < pairs.length; start += BATCH)
      await send(pairs.slice(start, start + BATCH), fetcher);
  } catch {
    rememberOnDevice(pairs, store);
  }
}

/** Move the device pairs to the server, then remove them from the device. */
export async function moveDeviceProofDismissals(
  fetcher: Fetcher = fetch,
  store: StorageLike | null = storage(),
): Promise<number> {
  const pairs = read(store).flatMap((key) => {
    const [accountId, providerThreadId, workId] = key.split('\u0000');
    return accountId && providerThreadId && workId ? [{ accountId, providerThreadId, workId }] : [];
  });
  if (!pairs.length) return 0;
  for (let start = 0; start < pairs.length; start += BATCH)
    await send(pairs.slice(start, start + BATCH), fetcher);
  try {
    store?.removeItem(PROOF_DISMISSALS_KEY);
  } catch {
    // A blocked store sends the same pairs again on the next load; saving a pair again is harmless.
  }
  return pairs.length;
}

let moved: Promise<unknown> | null = null;

/** Run the move once for each page load. A failure lets the next offer try again. */
export function moveDeviceProofDismissalsOnce(
  fetcher: Fetcher = fetch,
  store: StorageLike | null = storage(),
) {
  moved ??= moveDeviceProofDismissals(fetcher, store).catch(() => {
    moved = null;
  });
  return moved;
}

/** Leave out the pairs that are still only on this device. */
export function withoutDismissedProofMatches<T extends { workId: string }>(
  accountId: string,
  threadId: string,
  matches: T[],
  store: StorageLike | null = storage(),
): T[] {
  const keys = new Set(read(store));
  return matches.filter((match) => !keys.has(proofPairKey(accountId, threadId, match.workId)));
}

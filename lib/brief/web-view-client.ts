'use client';

import type { BriefHeadResponse, BriefViewResponse } from './web-view';

async function read<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || 'Could not load the brief.');
  return data as T;
}

/** The small poll: no edition, only the state of the active job. */
export async function fetchBriefHead(signal?: AbortSignal): Promise<BriefHeadResponse> {
  return read(await fetch('/api/brief/view', { cache: 'no-store', ...(signal ? { signal } : {}) }));
}

/** One edition. With `known`, the server sends it only when it changed. */
export async function fetchBriefView(
  body: { id?: string; known?: string | null },
  signal?: AbortSignal,
): Promise<BriefViewResponse> {
  return read(
    await fetch('/api/brief/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }),
  );
}

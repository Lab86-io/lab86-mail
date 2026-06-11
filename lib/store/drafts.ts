import { randomUUID } from 'node:crypto';
import type { Draft } from '../shared/types';
import { kvDelete, kvGet, kvList, kvUpsert } from './kv';

export async function saveDraft(draft: Draft): Promise<Draft> {
  draft.updatedAt = Date.now();
  if (!draft._id) draft._id = randomUUID();
  await kvUpsert('draft', draft._id, draft, draft.account);
  return draft;
}

export async function listDrafts(account: string): Promise<Draft[]> {
  const rows = await kvList<Draft>('draft', { ref: account, limit: 500 });
  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return rows;
}

export async function getDraft(id: string): Promise<Draft | null> {
  return await kvGet<Draft>('draft', id);
}

export async function deleteDraft(id: string) {
  await kvDelete('draft', id);
}

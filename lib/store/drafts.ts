import { db, findMany, findOne, insertOne, removeMany } from './db';
import type { Draft } from '../shared/types';

export async function saveDraft(draft: Draft): Promise<Draft> {
  draft.updatedAt = Date.now();
  if (draft._id) {
    await db().drafts.updateAsync({ _id: draft._id }, { $set: draft });
    return draft;
  }
  return await insertOne<Draft>(db().drafts, draft);
}

export async function listDrafts(account: string): Promise<Draft[]> {
  return await findMany<Draft>(db().drafts, { account }, { sort: { updatedAt: -1 } });
}

export async function getDraft(id: string): Promise<Draft | null> {
  return await findOne<Draft>(db().drafts, { _id: id });
}

export async function deleteDraft(id: string) {
  return await removeMany(db().drafts, { _id: id });
}

import { db, findOne, upsert } from './db';
import type { Pref } from '../shared/types';

export async function getPref(key: string): Promise<string | null> {
  const row = await findOne<Pref>(db().prefs, { _id: key });
  return row?.value ?? null;
}

export async function setPref(key: string, value: string) {
  const doc: Pref = { _id: key, value };
  await upsert(db().prefs, { _id: key }, doc);
}

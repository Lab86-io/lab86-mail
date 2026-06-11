import { kvGet, kvUpsert } from './kv';

export async function getPref(key: string): Promise<string | null> {
  const doc = await kvGet<{ value: string }>('pref', key);
  return doc?.value ?? null;
}

export async function setPref(key: string, value: string) {
  await kvUpsert('pref', key, { value });
}

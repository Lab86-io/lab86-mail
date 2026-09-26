import { kvGet, kvUpsert } from './kv';

/**
 * Pinned models in the model picker, kept for each user so the pins follow
 * the account to each device. Web and native read and write them through
 * /api/prefs (`pinnedModels`).
 */
const KIND = 'modelPins';
const KEY = 'default';
export const MODEL_PIN_LIMIT = 100;
const MODEL_ID_MAX_CHARS = 200;

/** A sorted, unique list of model ids. Bad entries are dropped, not rejected. */
export function normalizeModelPins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.trim())
    .filter((id) => id && id.length <= MODEL_ID_MAX_CHARS);
  return [...new Set(ids)].sort().slice(0, MODEL_PIN_LIMIT);
}

export async function getModelPins(): Promise<string[]> {
  const doc = await kvGet<{ ids?: unknown }>(KIND, KEY);
  return normalizeModelPins(doc?.ids);
}

export async function setModelPins(value: unknown): Promise<string[]> {
  const ids = normalizeModelPins(value);
  await kvUpsert(KIND, KEY, { ids });
  return ids;
}

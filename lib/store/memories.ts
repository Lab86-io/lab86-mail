import type { Memory } from '../shared/types';
import { kvDelete, kvGet, kvList, kvUpsert } from './kv';

export type RememberMode = 'append' | 'replace';

/** Saved notes stay bounded. Appends drop the oldest lines first. */
export const MEMORY_NOTES_MAX_CHARS = 4000;

/** The notes after one save: a new note adds a line, and a repeat changes nothing. */
export function mergeMemoryNotes(existing: string | undefined, next: string, mode: RememberMode = 'append') {
  const note = next.trim();
  const saved = (existing || '').trim();
  if (mode === 'replace' || !saved) return note.slice(-MEMORY_NOTES_MAX_CHARS);
  if (!note || saved.split('\n').some((line) => line.trim() === note)) return saved;
  const lines = [...saved.split('\n'), note];
  while (lines.length > 1 && lines.join('\n').length > MEMORY_NOTES_MAX_CHARS) lines.shift();
  return lines.join('\n').slice(-MEMORY_NOTES_MAX_CHARS);
}

/** Save a note for an email. The default adds to the saved notes; replace rewrites them. */
export async function rememberSender(email: string, notes: string, mode: RememberMode = 'append') {
  const key = email.toLowerCase();
  const existing = mode === 'append' ? await kvGet<Memory>('memory', key) : null;
  const doc: Memory = {
    _id: key,
    email: key,
    notes: mergeMemoryNotes(existing?.notes, notes, mode),
    updatedAt: Date.now(),
  };
  await kvUpsert('memory', key, doc);
  return doc;
}

export async function recallSender(email: string): Promise<Memory | null> {
  return await kvGet<Memory>('memory', email.toLowerCase());
}

export async function listMemories(): Promise<Memory[]> {
  const rows = await kvList<Memory>('memory', { limit: 500 });
  return rows.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

export async function forgetSender(email: string) {
  await kvDelete('memory', email.toLowerCase());
}

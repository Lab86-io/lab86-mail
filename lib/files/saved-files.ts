// Saved files (docs/albatross-goal-runs.md): bytes that Albatross got or made
// for the user, such as a web download, a filled PDF, or a PDF export. They
// live in agentUploads and show in Files with the user's uploads.

import { createHash } from 'node:crypto';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';

export const SAVED_FILE_MAX_BYTES = 25 * 1024 * 1024;

export type SavedFileOrigin = 'web' | 'filled' | 'export';

/** A form field whose value comes from the secure store at send or download time, never stored. */
export interface SealedField {
  field: string;
  ref: string;
}

export interface SaveFileInput {
  userId: string;
  bytes: Uint8Array;
  name: string;
  contentType: string;
  origin: SavedFileOrigin;
  sourceUrl?: string;
  sealedFields?: SealedField[];
  workId?: string;
}

/** The shared tool result shape for a saved file (docs/albatross-goal-runs.md, Tool results). */
export interface SavedFile {
  fileId: string;
  title: string;
  openPath: string;
  size: number;
  contentType: string;
  sha256: string;
  sourceUrl?: string;
}

export class SavedFileError extends Error {}

const defaults = {
  convexMutation: convexMutation as <T>(fn: any, args: Record<string, unknown>) => Promise<T>,
  fetch: (url: string, init: RequestInit) => fetch(url, init),
};
let dependencies = defaults;
export function __setSavedFilesDepsForTest(overrides: Partial<typeof defaults> = {}) {
  dependencies = { ...defaults, ...overrides };
}

/** Where a saved file opens in the app. */
export function savedFileOpenPath(fileId: string): string {
  return `/?view=files&file=${encodeURIComponent(fileId)}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A safe file name: no path parts, no control characters, at most 120 characters. */
export function savedFileName(name: string, fallback = 'file'): string {
  const base = name.split(/[\\/]/).pop() || '';
  const clean = Array.from(base)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return (clean || fallback).slice(-120);
}

export async function saveFileBytes(input: SaveFileInput): Promise<SavedFile> {
  if (!input.bytes.byteLength) throw new SavedFileError('The file is empty.');
  if (input.bytes.byteLength > SAVED_FILE_MAX_BYTES)
    throw new SavedFileError('The file is larger than 25 MB.');
  const name = savedFileName(input.name);
  const sha256 = sha256Hex(input.bytes);
  const uploadUrl = await dependencies.convexMutation<string>(api.agentUploads.generateUploadUrl, {
    userId: input.userId,
  });
  const response = await dependencies.fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': input.contentType },
    body: new Uint8Array(input.bytes),
    signal: AbortSignal.timeout(45_000),
    redirect: 'error',
  });
  if (!response.ok) throw new SavedFileError('The file could not be stored.');
  const { storageId } = (await response.json()) as { storageId?: string };
  if (!storageId) throw new SavedFileError('Storage did not confirm this file.');
  const fileId = await dependencies.convexMutation<string>(api.agentUploads.registerUpload, {
    userId: input.userId,
    storageId,
    name,
    contentType: input.contentType,
    size: input.bytes.byteLength,
    origin: input.origin,
    sha256,
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.sealedFields?.length ? { sealedFields: input.sealedFields } : {}),
    ...(input.workId ? { workId: input.workId } : {}),
  });
  return {
    fileId: String(fileId),
    title: name,
    openPath: savedFileOpenPath(String(fileId)),
    size: input.bytes.byteLength,
    contentType: input.contentType,
    sha256,
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
  };
}

/** One saved file row as the server reads it (convex/agentUploads.ts getUpload). */
export interface SavedFileRow {
  _id: string;
  userId: string;
  storageId: string;
  name: string;
  contentType?: string;
  size: number;
  createdAt: number;
  origin?: SavedFileOrigin;
  sourceUrl?: string;
  sha256?: string;
  sealedFields?: SealedField[];
  workId?: string;
  /** A short-lived storage address. Only the server reads it; no client gets it from here. */
  url: string | null;
}

const readDefaults = {
  convexQuery: convexQuery as <T>(fn: any, args: Record<string, unknown>) => Promise<T>,
  fetch: (url: string, init: RequestInit) => fetch(url, init),
};
let readDependencies = readDefaults;
export function __setSavedFileReadDepsForTest(overrides: Partial<typeof readDefaults> = {}) {
  readDependencies = { ...readDefaults, ...overrides };
}

/** The user's own saved file, or null. An id of another user, or no id at all, is null. */
export async function getSavedFileRow(userId: string, fileId: string): Promise<SavedFileRow | null> {
  const id = String(fileId || '').trim();
  if (!userId || !id || id.length > 200) return null;
  try {
    const row = await readDependencies.convexQuery<SavedFileRow | null>(api.agentUploads.getUpload, {
      userId,
      uploadId: id,
    });
    return row && row.userId === userId ? { ...row, _id: String(row._id) } : null;
  } catch {
    // A malformed id fails the Convex validator: it names no file of this user.
    return null;
  }
}

/** The stored bytes of a saved file, at most 25 MB. */
export async function readSavedFileBytes(row: Pick<SavedFileRow, 'url' | 'size'>): Promise<Uint8Array> {
  if (!row.url) throw new SavedFileError('This file is not in storage any more.');
  if (row.size > SAVED_FILE_MAX_BYTES) throw new SavedFileError('The file is larger than 25 MB.');
  const response = await readDependencies.fetch(row.url, {
    signal: AbortSignal.timeout(45_000),
    redirect: 'error',
  });
  if (!response.ok || !response.body) throw new SavedFileError('The file could not be read.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > SAVED_FILE_MAX_BYTES) throw new SavedFileError('The file is larger than 25 MB.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** True when the row or its name says PDF. */
export function isPdfFile(row: Pick<SavedFileRow, 'contentType' | 'name'>): boolean {
  return /pdf/i.test(row.contentType || '') || /\.pdf$/i.test(row.name || '');
}

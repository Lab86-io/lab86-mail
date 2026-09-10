import { randomUUID } from 'node:crypto';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import {
  OFFICE_MIME,
  OfficeError,
  type OfficeExtension,
  officeConfiguration,
  signOfficeToken,
} from './office-security';

const office = (api as any).officeDocuments;
const defaults = {
  convexQuery,
  convexMutation,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  randomUUID,
};
let dependencies = defaults;
export function __setOfficeServiceDepsForTest(overrides: Partial<typeof defaults> = {}) {
  dependencies = { ...defaults, ...overrides };
}
export interface OfficeFile {
  documentId: string;
  title: string;
  extension: OfficeExtension;
  currentRevision: number;
  createdAt: number;
  updatedAt: number;
  versions: Array<{ revision: number; recovery: boolean; createdAt: number; size: number }>;
  version: { revision: number; url: string | null; size: number; sha256: string } | null;
}
export function requireOffice(existingSession = false) {
  const configuration = officeConfiguration(process.env, existingSession);
  if (!configuration)
    throw new OfficeError(
      'Office editing is not enabled. A licensed document server must be configured first.',
      503,
    );
  return configuration;
}
export const listOfficeFiles = (userId: string) =>
  dependencies.convexQuery<OfficeFile[]>(office.list, { userId });
export const getOfficeFile = (userId: string, documentId: string, revision?: number) =>
  dependencies.convexQuery<OfficeFile | null>(office.get, { userId, documentId, revision });
export const getOfficeSession = (userId: string, documentId: string, sessionId: string) =>
  dependencies.convexQuery<{ key: string; baseRevision: number } | null>(office.getSession, {
    userId,
    documentId,
    sessionId,
  });

export async function storeOfficeBytes(userId: string, bytes: Uint8Array, extension: OfficeExtension) {
  const uploadUrl = await dependencies.convexMutation<string>(office.uploadUrl, { userId });
  const response = await dependencies.fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': OFFICE_MIME[extension] },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(45_000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new OfficeError('The working copy could not be stored. Your original file has not changed.', 502);
  const result = (await response.json()) as { storageId?: string };
  if (!result.storageId) throw new OfficeError('Storage did not confirm this file.', 502);
  return result.storageId;
}

export const createOfficeFile = (input: {
  userId: string;
  title: string;
  extension: OfficeExtension;
  storageId: string;
  size: number;
  sha256: string;
}) =>
  dependencies.convexMutation<OfficeFile>(office.create, { ...input, documentId: dependencies.randomUUID() });
export const saveOfficeVersion = (input: {
  userId: string;
  documentId: string;
  sessionId: string;
  key: string;
  expectedRevision: number;
  storageId: string;
  size: number;
  sha256: string;
}) =>
  dependencies.convexMutation<{ ok: boolean; code?: string; revision?: number }>(office.saveVersion, input);

export async function startOfficeSession(userId: string, document: OfficeFile) {
  const configuration = requireOffice();
  const sessionId = dependencies.randomUUID();
  const key = `${document.documentId}-${document.currentRevision}-${sessionId}`;
  const result = await dependencies.convexMutation<{ ok: boolean; expiresAt?: number }>(office.startSession, {
    userId,
    documentId: document.documentId,
    sessionId,
    key,
    expectedRevision: document.currentRevision,
  });
  if (!result.ok || !result.expiresAt)
    throw new OfficeError('The file changed before the editor opened. Reopen it.', 409);
  const exp = Math.floor(result.expiresAt / 1000);
  const token = (purpose: string) =>
    signOfficeToken(
      {
        purpose,
        userId,
        documentId: document.documentId,
        sessionId,
        revision: document.currentRevision,
        exp,
      },
      configuration.secret,
    );
  const base = `${configuration.app}/api/office/${encodeURIComponent(document.documentId)}`;
  const config = {
    documentType: document.extension === 'docx' ? 'word' : document.extension === 'xlsx' ? 'cell' : 'slide',
    type: 'desktop',
    width: '100%',
    height: '100%',
    document: {
      fileType: document.extension,
      key,
      title: document.title,
      url: `${base}/content?token=${token('download')}`,
      permissions: { edit: true, download: true, print: true, review: true, comment: true },
    },
    editorConfig: {
      mode: 'edit',
      callbackUrl: `${base}/callback?token=${token('callback')}`,
      user: { id: userId, name: 'You' },
      customization: { autosave: true, forcesave: true, help: false, compactHeader: true },
    },
  };
  return {
    serverUrl: configuration.server,
    config: { ...config, token: signOfficeToken(config, configuration.secret) },
  };
}

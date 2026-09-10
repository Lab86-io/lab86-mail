import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { OFFICE_MIME, verifyOfficeToken } from '../lib/documents/office-security';
import {
  __setOfficeServiceDepsForTest,
  createOfficeFile,
  getOfficeFile,
  getOfficeSession,
  listOfficeFiles,
  type OfficeFile,
  requireOffice,
  saveOfficeVersion,
  startOfficeSession,
  storeOfficeBytes,
} from '../lib/documents/office-service';

const configuration = {
  OFFICE_EDITOR_ENABLED: 'true',
  OFFICE_LICENSE_ACCEPTED: 'true',
  OFFICE_JWT_SECRET: 'synthetic-office-secret-with-more-than-32-characters',
  OFFICE_DOCUMENT_SERVER_URL: 'https://office.example.test',
  OFFICE_APP_ORIGIN: 'https://mail.example.test',
};
let previous: Record<string, string | undefined>;
beforeEach(() => {
  previous = Object.fromEntries(Object.keys(configuration).map((key) => [key, process.env[key]]));
  Object.assign(process.env, configuration);
});
afterEach(() => {
  __setOfficeServiceDepsForTest();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const document = (extension: OfficeFile['extension'] = 'docx'): OfficeFile => ({
  documentId: 'doc-1',
  title: 'Synthetic working copy',
  extension,
  currentRevision: 3,
  createdAt: 1,
  updatedAt: 2,
  versions: [],
  version: null,
});

test('new sessions stay disabled without deliberate configuration', () => {
  expect(requireOffice().server).toBe(configuration.OFFICE_DOCUMENT_SERVER_URL);
  process.env.OFFICE_EDITOR_ENABLED = 'false';
  expect(() => requireOffice()).toThrow('not enabled');
  expect(requireOffice(true).server).toBe(configuration.OFFICE_DOCUMENT_SERVER_URL);
  process.env.OFFICE_LICENSE_ACCEPTED = 'false';
  expect(() => requireOffice()).toThrow('not enabled');
  // Existing, authenticated sessions can still save their work after disablement.
  expect(requireOffice(true).server).toBe(configuration.OFFICE_DOCUMENT_SERVER_URL);
});

test('reads and writes preserve the exact private owner, document and revision scope', async () => {
  const query = mock(async (_ref: unknown, args: unknown) => args);
  const mutation = mock(async (_ref: unknown, args: unknown) => args);
  __setOfficeServiceDepsForTest({
    convexQuery: query as any,
    convexMutation: mutation as any,
    randomUUID: () => '11111111-1111-1111-1111-111111111111',
  });
  expect(await listOfficeFiles('owner')).toEqual({ userId: 'owner' });
  expect(await getOfficeFile('owner', 'doc', 2)).toEqual({ userId: 'owner', documentId: 'doc', revision: 2 });
  expect(await getOfficeSession('owner', 'doc', 'session')).toEqual({
    userId: 'owner',
    documentId: 'doc',
    sessionId: 'session',
  });
  const created = await createOfficeFile({
    userId: 'owner',
    title: 'Private',
    extension: 'docx',
    storageId: 'bytes',
    size: 3,
    sha256: 'hash',
  });
  expect(created).toMatchObject({ userId: 'owner', documentId: '11111111-1111-1111-1111-111111111111' });
  const input = {
    userId: 'owner',
    documentId: 'doc',
    sessionId: 'session',
    key: 'key',
    expectedRevision: 3,
    storageId: 'next-bytes',
    size: 4,
    sha256: 'next-hash',
  };
  expect(await saveOfficeVersion(input)).toEqual(input);
});

test('binary upload is bounded, nonredirecting and requires an explicit storage identity', async () => {
  const upload = mock(async (_url: unknown, _init: unknown) => Response.json({ storageId: 'stored-bytes' }));
  __setOfficeServiceDepsForTest({
    convexMutation: (async () => 'https://storage.example.test/upload') as any,
    fetch: upload as any,
  });
  expect(await storeOfficeBytes('owner', new Uint8Array([1, 2, 3]), 'pptx')).toBe('stored-bytes');
  const [url, init] = upload.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('https://storage.example.test/upload');
  expect(init.redirect).toBe('error');
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(init.headers).toEqual({ 'Content-Type': OFFICE_MIME.pptx });
  expect([...new Uint8Array(init.body as Uint8Array)]).toEqual([1, 2, 3]);
  for (const response of [new Response('failure', { status: 503 }), Response.json({})]) {
    __setOfficeServiceDepsForTest({
      convexMutation: (async () => 'https://storage.example.test/upload') as any,
      fetch: (async () => response) as any,
    });
    await expect(storeOfficeBytes('owner', new Uint8Array([1]), 'docx')).rejects.toThrow();
  }
});

test('session capabilities bind owner, file, revision, purpose and expiry for every editor kind', async () => {
  const expiresAt = Date.now() + 60_000;
  const mutation = mock(async (_ref: unknown, _input: unknown) => ({ ok: true, expiresAt }));
  __setOfficeServiceDepsForTest({ convexMutation: mutation as any });
  for (const [extension, kind] of [
    ['docx', 'word'],
    ['xlsx', 'cell'],
    ['pptx', 'slide'],
  ] as const) {
    const result = await startOfficeSession('owner', document(extension));
    expect(result.serverUrl).toBe(configuration.OFFICE_DOCUMENT_SERVER_URL);
    expect(result.config.documentType).toBe(kind);
    const claims = verifyOfficeToken(result.config.token, configuration.OFFICE_JWT_SECRET);
    expect(claims).toMatchObject({ document: { key: result.config.document.key } });
    expect(mutation.mock.calls.at(-1)?.[1]).toMatchObject({
      userId: 'owner',
      documentId: 'doc-1',
      expectedRevision: 3,
    });
    for (const [url, purpose] of [
      [result.config.document.url, 'download'],
      [result.config.editorConfig.callbackUrl, 'callback'],
    ]) {
      const endpoint = new URL(url);
      expect(endpoint.origin).toBe(configuration.OFFICE_APP_ORIGIN);
      expect(
        verifyOfficeToken(endpoint.searchParams.get('token')!, configuration.OFFICE_JWT_SECRET),
      ).toMatchObject({
        purpose,
        userId: 'owner',
        documentId: 'doc-1',
        revision: 3,
        exp: Math.floor(expiresAt / 1000),
      });
    }
  }
});

test('a failed or incomplete session commit never exposes an editor configuration', async () => {
  for (const result of [{ ok: false }, { ok: true }]) {
    __setOfficeServiceDepsForTest({ convexMutation: (async () => result) as any });
    await expect(startOfficeSession('owner', document())).rejects.toThrow('file changed');
  }
});

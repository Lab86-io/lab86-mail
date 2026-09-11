import { afterEach, describe, expect, test } from 'bun:test';
import { __setCollaboraDepsForTest, startCollaboraSession, wopiContext } from '../lib/documents/collabora';
import { signOfficeToken, verifyOfficeToken } from '../lib/documents/office-security';

const config = {
  server: 'https://documents.test',
  app: 'https://app.test',
  secret: 'x'.repeat(32),
  provider: 'collabora' as const,
};
const file = {
  documentId: 'private-file',
  title: 'Plan.docx',
  extension: 'docx',
  currentRevision: 3,
  version: { url: 'https://storage.test/file', size: 50 },
} as any;
const session = { key: 'editor-session', baseRevision: 3 };
const expiresAt = Date.now() + 86400000;
const discovery = `<wopi-discovery><action ext="docx" name="edit" urlsrc="https://documents.test/browser/hash/cool.html?&lt;ui=UI_LLCC&amp;&gt;" /></wopi-discovery>`;
function setup(overrides: Parameters<typeof __setCollaboraDepsForTest>[0] = {}) {
  __setCollaboraDepsForTest({
    requireOffice: () => config,
    fetch: async () => new Response(discovery),
    convexMutation: (async () => ({ ok: true, expiresAt })) as any,
    getOfficeSession: async () => session,
    getOfficeFile: async () => file,
    ...overrides,
  });
}
afterEach(() => __setCollaboraDepsForTest());
function capability(overrides: Record<string, unknown> = {}) {
  return signOfficeToken(
    {
      purpose: 'wopi',
      userId: 'owner',
      documentId: file.documentId,
      sessionId: 'session',
      exp: Math.floor(expiresAt / 1000),
      ...overrides,
    },
    config.secret,
  );
}
const request = (token: string) =>
  new Request(`https://app.test/api/office/wopi/${file.documentId}?access_token=${token}`);
describe('Collabora integration boundaries', () => {
  test('discovers the editor and creates an expiring, owner/document-bound session', async () => {
    let sessionArgs: any;
    setup({
      convexMutation: (async (_reference, args) => {
        sessionArgs = args;
        return { ok: true, expiresAt };
      }) as any,
    });
    const result = await startCollaboraSession('owner', file);
    const url = new URL(result.editorUrl);
    expect(url.origin).toBe(config.server);
    expect(url.searchParams.get('WOPISrc')).toBe('https://app.test/api/office/wopi/private-file');
    expect(url.searchParams.get('lang')).toBe('en-US');
    expect(url.toString()).not.toContain('UI_LLCC');
    expect(sessionArgs.userId).toBe('owner');
    expect(sessionArgs.expectedRevision).toBe(3);
    expect(verifyOfficeToken(result.accessToken, config.secret)).toMatchObject({
      userId: 'owner',
      documentId: 'private-file',
      purpose: 'wopi',
      exp: Math.floor(expiresAt / 1000),
    });
  });
  test('unavailable/unsupported discovery and redirected editor origins are refused', async () => {
    setup({ fetch: async () => new Response('', { status: 503 }) });
    await expect(startCollaboraSession('owner', file)).rejects.toThrow('unavailable');
    setup({ fetch: async () => new Response('<wopi-discovery/>') });
    await expect(startCollaboraSession('owner', file)).rejects.toThrow('cannot edit');
    setup({
      fetch: async () =>
        new Response(discovery.replace('https://documents.test/browser', 'https://attacker.test/browser')),
    });
    await expect(startCollaboraSession('owner', file)).rejects.toThrow('unexpected editor address');
    setup({ convexMutation: (async () => ({ ok: false })) as any });
    await expect(startCollaboraSession('owner', file)).rejects.toThrow('working copy changed');
  });
  test('valid capabilities resolve only the signed owner and exact session', async () => {
    const calls: string[][] = [];
    setup({
      getOfficeSession: async (...args) => {
        calls.push(args);
        return session;
      },
      getOfficeFile: async (userId, documentId) => {
        calls.push([userId, documentId]);
        return file;
      },
    });
    const result = await wopiContext(request(capability()), file.documentId);
    expect(result.userId).toBe('owner');
    expect(result.file.documentId).toBe('private-file');
    expect(calls).toEqual([
      ['owner', 'private-file', 'session'],
      ['owner', 'private-file'],
    ]);
    const bearer = new Request('https://app.test/office', {
      headers: { Authorization: `Bearer ${capability()}` },
    });
    expect((await wopiContext(bearer, file.documentId)).sessionId).toBe('session');
  });
  test('malformed, expired, wrong-purpose and wrong-document tokens cannot access a file', async () => {
    setup({
      getOfficeFile: async () => {
        throw new Error('must not read');
      },
    });
    for (const token of [
      '',
      'malformed',
      capability({ exp: undefined }),
      capability({ exp: 1 }),
      capability({ purpose: 'callback' }),
      capability({ documentId: 'someone-elses-file' }),
      capability({ sessionId: 123 }),
    ]) {
      await expect(wopiContext(request(token), file.documentId)).rejects.toThrow();
    }
  });
  test('revoked sessions and missing storage cannot open the editor', async () => {
    setup({ getOfficeSession: async () => null });
    await expect(wopiContext(request(capability()), file.documentId)).rejects.toThrow('session expired');
    setup({ getOfficeFile: async () => null });
    await expect(wopiContext(request(capability()), file.documentId)).rejects.toThrow('not found');
  });
});

test('PutFile accepts the shared lock across sessions and returns the current lock on save races', async () => {
  const { POST } = await import('../app/api/office/wopi/[documentId]/contents/route');
  const { __setOfficeServiceDepsForTest } = await import('../lib/documents/office-service');
  const { exportDocument } = await import('../lib/documents/export');
  const { createDefaultDocumentModel } = await import('../lib/documents/model');
  const bytes = (
    await exportDocument({
      documentId: 'fixture',
      title: 'Fixture',
      kind: 'doc',
      model: createDefaultDocumentModel('doc'),
      currentRevision: 1,
      sourceRefs: [],
      createdAt: 1,
      updatedAt: 1,
    })
  ).bytes;
  const expiresAt = Date.now() + 60000;
  setup({
    getOfficeFile: async () => ({
      ...file,
      wopiLock: { value: 'shared-lock', sessionId: 'different-editor', expiresAt },
    }),
  });
  let mutations = 0;
  const makeRequest = () =>
    new Request(`https://app.test/api/office/wopi/${file.documentId}/contents?access_token=${capability()}`, {
      method: 'POST',
      headers: { 'x-wopi-lock': 'shared-lock' },
      body: new Uint8Array(bytes),
    });
  try {
    __setOfficeServiceDepsForTest({
      convexMutation: (async () =>
        ++mutations % 2 ? 'https://storage.test/upload' : { ok: false, code: 'LOCK_CONFLICT' }) as any,
      fetch: async () => Response.json({ storageId: 'uploaded' }),
      convexQuery: (async () => ({ ...file, wopiLock: { value: 'new-lock', expiresAt } })) as any,
    });
    const conflict = await POST(makeRequest(), { params: Promise.resolve({ documentId: file.documentId }) });
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get('x-wopi-lock')).toBe('new-lock');
    __setOfficeServiceDepsForTest({
      convexMutation: (async () =>
        ++mutations % 2 ? 'https://storage.test/upload' : { ok: true, revision: 4, updatedAt: 1000 }) as any,
      fetch: async () => Response.json({ storageId: 'uploaded' }),
    });
    const success = await POST(makeRequest(), { params: Promise.resolve({ documentId: file.documentId }) });
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ LastModifiedTime: '1970-01-01T00:00:01.000Z' });
  } finally {
    __setOfficeServiceDepsForTest();
  }
});

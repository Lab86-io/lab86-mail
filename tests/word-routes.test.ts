import { expect, mock, test } from 'bun:test';
import { createWordEditingPost } from '../app/api/office/[documentId]/editing/route';
import { createWordPost } from '../app/api/office/word/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { OfficeError, signOfficeToken } from '../lib/documents/office-security';

const auth = {
  requireCurrentUser: async () => ({ userId: 'owner', email: '', name: '', source: 'clerk' as const }),
  enforceUserRateLimit: async () => ({ ok: true as const }),
};
const request = (body: unknown) =>
  new Request('https://app.test/api/office/word', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
test('Word creation authenticates, bounds input, validates content, and preserves source revision conflicts', async () => {
  const create = mock(async () => ({
    ok: true as const,
    documentId: 'word',
    title: 'Report.docx',
    revision: 1,
    openPath: '/?view=files&office=word',
  }));
  const post = createWordPost({ ...auth, create });
  const response = await post(
    request({ title: 'Report', edits: [{ op: 'insert_paragraph', text: 'Hello' }] }),
  );
  expect(response.status).toBe(201);
  expect((await response.json()).document.openPath).toContain('office=word');
  expect(create).toHaveBeenCalledWith('owner', {
    title: 'Report',
    edits: [{ op: 'insert_paragraph', text: 'Hello' }],
  });
  expect((await post(request({ title: 'Report', arbitrary: true }))).status).toBe(400);
  expect((await post(request({ title: 'x'.repeat(2_000_001) }))).status).toBe(413);
  expect(create).toHaveBeenCalledTimes(1);
  const unauthorized = createWordPost({
    ...auth,
    create,
    requireCurrentUser: async () => {
      throw new AuthRequiredError();
    },
  });
  expect((await unauthorized(request({ title: 'Report' }))).status).toBe(401);
  expect(create).toHaveBeenCalledTimes(1);
  const conflict = createWordPost({
    ...auth,
    create: async () => {
      throw new OfficeError('Source changed', 409);
    },
  });
  expect(
    (await conflict(request({ title: 'Copy', sourceDocumentId: 'simple', expectedRevision: 2 }))).status,
  ).toBe(409);
});

test('editor coordination binds an unexpired capability to the owner, document, and actual session', async () => {
  const mutation = mock(async () => ({ ok: true }));
  const post = createWordEditingPost({
    ...auth,
    requireOffice: () => ({ secret: 'secret' }) as any,
    convexMutation: mutation as any,
  });
  const claims = {
    purpose: 'wopi',
    documentId: 'word',
    userId: 'owner',
    sessionId: 'browser',
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const body = (overrides = {}) => ({
    requestId: '11111111-1111-4111-8111-111111111111',
    token: signOfficeToken({ ...claims, ...overrides }, 'secret'),
  });
  const context = { params: Promise.resolve({ documentId: 'word' }) };
  expect((await post(request(body()), context)).status).toBe(200);
  expect(mutation.mock.calls[0]).toEqual([
    expect.anything(),
    expect.objectContaining({ userId: 'owner', documentId: 'word', sessionId: 'browser', action: 'prepare' }),
  ]);
  expect((await post(request({ ...body(), failed: true }), context)).status).toBe(200);
  expect((mutation.mock.calls as any)[1][1].action).toBe('fail');
  for (const override of [
    { userId: 'other' },
    { documentId: 'other' },
    { purpose: 'download' },
    { sessionId: undefined },
    { exp: undefined },
  ])
    expect((await post(request(body(override)), context)).status).toBe(403);
  expect((await post(request(body({ exp: 1 })), context)).status).toBe(401);
  expect((await post(request({ ...body(), token: 'invalid' }), context)).status).toBe(401);
  expect((await post(request({ ...body(), requestId: 'invalid' }), context)).status).toBe(400);
  expect(mutation).toHaveBeenCalledTimes(2);
});

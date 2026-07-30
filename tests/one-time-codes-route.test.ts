import { describe, expect, mock, test } from 'bun:test';
import { createConsumeHandlers } from '../app/api/mobile/one-time-codes/consume/route';
import { createOneTimeCodeHandlers } from '../app/api/mobile/one-time-codes/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { OneTimeCodeNotFoundError } from '../lib/mail/one-time-code-cleanup';

const USER = { userId: 'user-1', email: 'a@b.c', name: 'A' } as any;

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://mail.lab86.io/api/mobile/one-time-codes/consume', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as any;
}

function consumeDeps(overrides: Record<string, any> = {}) {
  return {
    requireCurrentUser: mock(async () => USER),
    verifyConsumeToken: mock(() => ({ ok: true, userId: 'token-user' })),
    consumeOneTimeCode: mock(async () => ({
      ok: true,
      cleanup: 'archive',
      cleanupStatus: 'archived',
      alreadyUsed: false,
    })),
    reportUnexpectedError: mock(() => undefined),
    ...overrides,
  } as any;
}

describe('consume route authentication', () => {
  test('uses the scoped token when present, never the session', async () => {
    const deps = consumeDeps();
    const response = await createConsumeHandlers(deps).POST(
      request({ codeId: 'code-1', cleanup: 'archive' }, { 'x-lab86-consume-token': 'tok' }),
    );

    expect(response.status).toBe(200);
    // The extension has no session; asking for one would throw rather than 401.
    expect(deps.requireCurrentUser).not.toHaveBeenCalled();
    expect(deps.verifyConsumeToken).toHaveBeenCalledWith('tok');
    expect(deps.consumeOneTimeCode.mock.calls[0][0].userId).toBe('token-user');
  });

  test('rejects an invalid scoped token without falling back to the session', async () => {
    const deps = consumeDeps({
      verifyConsumeToken: mock(() => ({ ok: false, reason: 'bad_signature' })),
    });
    const response = await createConsumeHandlers(deps).POST(
      request({ codeId: 'code-1' }, { 'x-lab86-consume-token': 'forged' }),
    );

    expect(response.status).toBe(401);
    // Falling back here would let a forged token be silently upgraded to
    // whatever session the request happened to carry.
    expect(deps.requireCurrentUser).not.toHaveBeenCalled();
    expect(deps.consumeOneTimeCode).not.toHaveBeenCalled();
  });

  test('uses the session when no token is supplied', async () => {
    const deps = consumeDeps();
    const response = await createConsumeHandlers(deps).POST(request({ codeId: 'code-1' }));

    expect(response.status).toBe(200);
    expect(deps.consumeOneTimeCode.mock.calls[0][0].userId).toBe('user-1');
  });

  test('401s when neither a token nor a session is present', async () => {
    const deps = consumeDeps({
      requireCurrentUser: mock(async () => {
        throw new AuthRequiredError('Sign in required.');
      }),
    });
    expect((await createConsumeHandlers(deps).POST(request({ codeId: 'code-1' }))).status).toBe(401);
  });
});

describe('consume route input handling', () => {
  test('400s without a codeId', async () => {
    const deps = consumeDeps();
    const response = await createConsumeHandlers(deps).POST(request({ cleanup: 'archive' }));
    expect(response.status).toBe(400);
    expect(deps.consumeOneTimeCode).not.toHaveBeenCalled();
  });

  test('passes the cleanup mode through, defaulting unknown values to none', async () => {
    const deps = consumeDeps();
    await createConsumeHandlers(deps).POST(request({ codeId: 'c', cleanup: 'trash' }));
    expect(deps.consumeOneTimeCode.mock.calls[0][0].cleanup).toBe('trash');

    const other = consumeDeps();
    await createConsumeHandlers(other).POST(request({ codeId: 'c', cleanup: 'incinerate' }));
    expect(other.consumeOneTimeCode.mock.calls[0][0].cleanup).toBe('none');
  });

  test('404s on an unknown code, and 500s on anything else', async () => {
    const missing = consumeDeps({
      consumeOneTimeCode: mock(async () => {
        throw new OneTimeCodeNotFoundError();
      }),
    });
    expect((await createConsumeHandlers(missing).POST(request({ codeId: 'gone' }))).status).toBe(404);

    const broken = consumeDeps({
      consumeOneTimeCode: mock(async () => {
        // Deliberately contains "not found" — a string match would misreport
        // this infrastructure fault to the client as a 404.
        throw new Error('convex upstream not found');
      }),
    });
    expect((await createConsumeHandlers(broken).POST(request({ codeId: 'c' }))).status).toBe(500);
  });
});

describe('one-time codes listing route', () => {
  function listDeps(overrides: Record<string, any> = {}) {
    return {
      requireCurrentUser: mock(async () => USER),
      convexQuery: mock(async (_fn: any, _args: any) => []),
      issueConsumeToken: mock(() => 'scoped-token'),
      reportUnexpectedError: mock(() => undefined),
      ...overrides,
    } as any;
  }

  test('never caches a response carrying live codes', async () => {
    const deps = listDeps({
      convexQuery: mock(async () => [{ id: 'c1', code: '284917', serviceIdentifiers: ['google.com'] }]),
    });
    const response = await createOneTimeCodeHandlers(deps).GET();

    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('cache-control')).toContain('private');
  });

  test('401s when signed out rather than returning an empty set', async () => {
    const deps = listDeps({
      requireCurrentUser: mock(async () => {
        throw new AuthRequiredError('Sign in required.');
      }),
    });
    expect((await createOneTimeCodeHandlers(deps).GET()).status).toBe(401);
  });
});

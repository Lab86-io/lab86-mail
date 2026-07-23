import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createCaptureAnalyzePost } from '../app/api/albatross/capture/analyze/route';
import { AuthRequiredError } from '../lib/auth/current-user';

function request(rawText = 'Prepare launch notes and book the review') {
  return new NextRequest('http://localhost/api/albatross/capture/analyze', {
    method: 'POST',
    body: JSON.stringify({ rawText }),
  });
}

function dependencies() {
  return {
    requireCurrentUser: async () => ({
      userId: 'capture_user',
      email: 'capture@example.test',
      name: 'Capture User',
      source: 'clerk' as const,
    }),
    enforceUserRateLimit: async () => ({ ok: true }),
    generateTextForCurrentUser: mock(async () => ({
      text: JSON.stringify({
        work: [
          { title: 'Prepare launch notes', rawText: 'Prepare launch notes' },
          { title: 'Book the review', rawText: 'Book the review' },
        ],
      }),
    })) as any,
    reportUnexpectedError: mock(() => undefined),
  };
}

describe('capture analysis route', () => {
  test('returns editable split work from the injected analysis path', async () => {
    const deps = dependencies();

    const response = await createCaptureAnalyzePost(deps as any)(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      work: [
        { title: 'Prepare launch notes', rawText: 'Prepare launch notes' },
        { title: 'Book the review', rawText: 'Book the review' },
      ],
    });
    expect(deps.reportUnexpectedError).not.toHaveBeenCalled();
  });

  test('preserves authentication failures without invoking analysis', async () => {
    const deps = dependencies();
    deps.requireCurrentUser = async () => {
      throw new AuthRequiredError('Sign in required.');
    };

    const response = await createCaptureAnalyzePost(deps as any)(request());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'Sign in required.' });
    expect(deps.generateTextForCurrentUser).not.toHaveBeenCalled();
  });

  test('reports unexpected failures and keeps private details out of the response', async () => {
    const deps = dependencies();
    const privateError = new Error('private AI gateway detail');
    deps.generateTextForCurrentUser.mockImplementation(async () => {
      throw privateError;
    });

    const response = await createCaptureAnalyzePost(deps as any)(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'Capture analysis failed.' });
    expect(deps.reportUnexpectedError).toHaveBeenCalledWith(privateError);
  });
});

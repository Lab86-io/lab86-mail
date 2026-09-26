import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createPrefsRoute } from '../app/api/prefs/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { MODEL_PIN_LIMIT, normalizeModelPins } from '../lib/store/model-pins';

function routeFor(userId: string) {
  return createPrefsRoute({
    requireCurrentUser: mock(async () => ({ userId, email: `${userId}@example.com`, name: null })) as any,
  });
}

function post(body: unknown) {
  return new NextRequest('http://localhost/api/prefs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('/api/prefs pinned models', () => {
  test('pins are saved for the user and come back on the next read', async () => {
    const route = routeFor('prefs-user-1');
    expect((await (await route.GET()).json()).prefs).toEqual({ undoSendSeconds: 10, pinnedModels: [] });
    const saved = await route.POST(post({ pinnedModels: ['z-ai/glm-5.3-flash', 'openai/gpt-5.5'] }));
    expect(await saved.json()).toEqual({
      ok: true,
      prefs: { pinnedModels: ['openai/gpt-5.5', 'z-ai/glm-5.3-flash'] },
    });
    expect((await (await route.GET()).json()).prefs.pinnedModels).toEqual([
      'openai/gpt-5.5',
      'z-ai/glm-5.3-flash',
    ]);
    // Another user has their own list.
    expect((await (await routeFor('prefs-user-2').GET()).json()).prefs.pinnedModels).toEqual([]);
  });

  test('saving the undo-send time leaves the pins alone', async () => {
    const route = routeFor('prefs-user-3');
    await route.POST(post({ pinnedModels: ['openai/gpt-5.5'] }));
    expect(await (await route.POST(post({ undoSendSeconds: 20 }))).json()).toEqual({
      ok: true,
      prefs: { undoSendSeconds: 20 },
    });
    expect((await (await route.GET()).json()).prefs).toEqual({
      undoSendSeconds: 20,
      pinnedModels: ['openai/gpt-5.5'],
    });
  });

  test('a pin list that is not a list is refused, and a bad JSON body too', async () => {
    const route = routeFor('prefs-user-4');
    expect((await route.POST(post({ pinnedModels: 'openai/gpt-5.5' }))).status).toBe(400);
    expect((await route.POST(post('{bad'))).status).toBe(400);
    expect((await (await route.GET()).json()).prefs.pinnedModels).toEqual([]);
  });

  test('a signed-out request gets 401', async () => {
    const route = createPrefsRoute({
      requireCurrentUser: mock(async () => {
        throw new AuthRequiredError('Sign in required.');
      }) as any,
    });
    expect((await route.GET()).status).toBe(401);
    expect((await route.POST(post({ pinnedModels: [] }))).status).toBe(401);
  });

  test('pin lists are cleaned: strings only, trimmed, unique, sorted, and bounded', () => {
    expect(normalizeModelPins(['b', ' a ', 'b', 3, '', 'x'.repeat(201)])).toEqual(['a', 'b']);
    expect(normalizeModelPins('a')).toEqual([]);
    expect(
      normalizeModelPins(Array.from({ length: 150 }, (_, i) => `m${String(i).padStart(3, '0')}`)),
    ).toHaveLength(MODEL_PIN_LIMIT);
  });
});

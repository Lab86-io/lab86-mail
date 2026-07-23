import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createMobileDeviceHandlers } from '../app/api/mobile/devices/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import {
  parseMobileDeviceRegistration,
  parseMobileDeviceRevocation,
} from '../lib/notifications/mobile-device';

const user = {
  userId: 'device_user',
  email: 'device@example.test',
  name: 'Device User',
  source: 'clerk' as const,
};
const token = 'ab'.repeat(32);
const registration = {
  platform: 'ios',
  token,
  deviceId: 'iphone-1',
  environment: 'production',
  appVersion: '31',
};

function request(method: 'POST' | 'DELETE', body: unknown) {
  return new NextRequest('http://localhost/api/mobile/devices', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function malformedRequest(method: 'POST' | 'DELETE') {
  return new NextRequest('http://localhost/api/mobile/devices', { method, body: '{' });
}

function dependencies() {
  return {
    requireCurrentUser: mock(async () => user),
    convexMutation: mock(async () => 'device_row_1') as any,
    parseMobileDeviceRegistration,
    parseMobileDeviceRevocation,
    reportUnexpectedError: mock(() => undefined),
  };
}

describe('mobile devices route', () => {
  test('registers and revokes an authenticated device', async () => {
    const deps = dependencies();
    const handlers = createMobileDeviceHandlers(deps as any);

    const registered = await handlers.POST(request('POST', registration));
    deps.convexMutation.mockResolvedValue({ revoked: 1 });
    const revoked = await handlers.DELETE(request('DELETE', { deviceId: 'iphone-1' }));

    expect(await registered.json()).toEqual({ ok: true, deviceId: 'device_row_1' });
    expect(await revoked.json()).toEqual({ ok: true, revoked: 1 });
    expect(deps.convexMutation.mock.calls[0][1]).toEqual({ userId: user.userId, ...registration });
    expect(deps.convexMutation.mock.calls[1][1]).toEqual({
      userId: user.userId,
      deviceId: 'iphone-1',
    });
  });

  test('returns 400 for malformed JSON in both handlers', async () => {
    const handlers = createMobileDeviceHandlers(dependencies() as any);

    const post = await handlers.POST(malformedRequest('POST'));
    const remove = await handlers.DELETE(malformedRequest('DELETE'));

    expect(post.status).toBe(400);
    expect(remove.status).toBe(400);
    expect(await post.json()).toEqual({ ok: false, error: 'Request body must be valid JSON.' });
    expect(await remove.json()).toEqual({ ok: false, error: 'Request body must be valid JSON.' });
  });

  test('returns controlled parser validation failures', async () => {
    const handlers = createMobileDeviceHandlers(dependencies() as any);

    const post = await handlers.POST(request('POST', { ...registration, token: 'bad' }));
    const remove = await handlers.DELETE(request('DELETE', {}));

    expect(post.status).toBe(400);
    expect(remove.status).toBe(400);
    expect((await post.json()).error).toBe('A valid APNs device token is required.');
    expect((await remove.json()).error).toBe('A token or deviceId is required.');
  });

  test('preserves authentication failures in both handlers', async () => {
    const deps = dependencies();
    deps.requireCurrentUser.mockImplementation(async () => {
      throw new AuthRequiredError('Sign in required.');
    });
    const handlers = createMobileDeviceHandlers(deps as any);

    const post = await handlers.POST(request('POST', registration));
    const remove = await handlers.DELETE(request('DELETE', { token }));

    expect(post.status).toBe(401);
    expect(remove.status).toBe(401);
    expect(await post.json()).toEqual({ ok: false, error: 'Sign in required.' });
  });

  test('does not expose Convex registration or revocation failures', async () => {
    const deps = dependencies();
    deps.convexMutation.mockImplementation(async () => {
      throw new Error('private Convex detail');
    });
    const handlers = createMobileDeviceHandlers(deps as any);

    const post = await handlers.POST(request('POST', registration));
    const remove = await handlers.DELETE(request('DELETE', { token }));

    expect(post.status).toBe(500);
    expect(remove.status).toBe(500);
    expect(await post.json()).toEqual({ ok: false, error: 'Push device update failed.' });
    expect(await remove.json()).toEqual({ ok: false, error: 'Push device update failed.' });
    expect(deps.reportUnexpectedError).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, mock, test } from 'bun:test';
import { createMobileCommandGet } from '../app/api/mobile/v1/commands/[id]/route';

const user = {
  userId: 'command_get_user',
  email: 'command@example.test',
  name: 'Command User',
  source: 'clerk' as const,
};

function request() {
  return new Request('http://localhost/api/mobile/v1/commands/command-1', {
    headers: { 'x-request-id': 'command-get-request' },
  });
}

function context() {
  return { params: Promise.resolve({ id: 'command-1' }) };
}

describe('mobile command lookup route', () => {
  test('returns the durable command receipt', async () => {
    const getCommand = mock(async () => ({
      _id: 'command-1',
      status: 'applied',
      entityRevision: 4,
    }));
    const get = createMobileCommandGet({
      requireCurrentUser: async () => user,
      getCommand,
    } as any);

    const response = await get(request(), context());

    expect(await response.json()).toEqual({
      commandID: 'command-1',
      status: 'applied',
      entityRevision: 4,
    });
    expect(getCommand).toHaveBeenCalledWith({ userId: user.userId, commandId: 'command-1' });
  });

  test('returns the standardized typed 404 envelope for a missing command', async () => {
    const get = createMobileCommandGet({
      requireCurrentUser: async () => user,
      getCommand: async () => null,
    } as any);

    const response = await get(request(), context());
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.error).toEqual({
      code: 'NOT_FOUND',
      message: 'Mobile command not found.',
      retryable: false,
    });
  });

  test('maps lookup failures through mobileErrorResponse', async () => {
    const get = createMobileCommandGet({
      requireCurrentUser: async () => user,
      getCommand: async () => {
        throw new Error('private lookup failure');
      },
    } as any);

    const response = await get(request(), context());

    expect(response.status).toBe(500);
    expect((await response.json()).error).toEqual({
      code: 'SERVER_ERROR',
      message: 'The server could not complete the request.',
      retryable: true,
    });
  });
});

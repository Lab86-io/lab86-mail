import { describe, expect, mock, test } from 'bun:test';
import { createMobileCommandPost } from '../app/api/mobile/v1/commands/route';

const user = {
  userId: 'command_user',
  email: 'command@example.test',
  name: 'Command User',
  source: 'clerk' as const,
};

const body = {
  idempotencyKey: 'command-key-1',
  kind: 'task.setCompleted',
  payload: { cardID: 'card-1', completed: true },
  baseRevision: 2,
  clientCreatedAt: '2026-07-23T12:00:00.000Z',
};

function request(value: unknown = body) {
  return new Request('http://localhost/api/mobile/v1/commands', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-request-id': 'command-request' },
    body: JSON.stringify(value),
  });
}

function command(status = 'queued') {
  return { _id: 'command-1', status };
}

function dependencies() {
  return {
    requireCurrentUser: mock(async () => user),
    enforceUserRateLimit: mock(async () => ({ ok: true })) as any,
    beginCommand: mock(async () => ({ command: command(), keyReused: false, created: true })) as any,
    claimCommand: mock(async () => ({ claimed: true, command: command() })) as any,
    completeCommand: mock(async (args: any) =>
      args.status === 'failed'
        ? {
            _id: 'command-1',
            status: 'failed',
            errorCode: args.errorCode,
            errorMessage: args.errorMessage,
            errorRetryable: args.errorRetryable,
          }
        : { _id: 'command-1', status: 'applied', entityRevision: 3, operationId: 'operation-1' },
    ) as any,
    executeMobileCommand: mock(async () => ({
      status: 'applied',
      syncDomain: 'tasks',
      entityKind: 'task',
      entityID: 'card-1',
      syncPayload: { cardID: 'card-1', completed: true },
      operationID: 'operation-1',
    })) as any,
    randomUUID: () => 'claim-token-1',
  };
}

describe('mobile command route', () => {
  test('runs begin, claim, execute, and complete with one durable lease', async () => {
    const deps = dependencies();

    const response = await createMobileCommandPost(deps as any)(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      commandID: 'command-1',
      status: 'applied',
      entityRevision: 3,
      operationID: 'operation-1',
    });
    expect(deps.beginCommand).toHaveBeenCalledTimes(1);
    expect(deps.claimCommand).toHaveBeenCalledWith({
      userId: user.userId,
      commandId: 'command-1',
      claimToken: 'claim-token-1',
      leaseMs: 300_000,
    });
    expect(deps.completeCommand.mock.calls[0][0]).toMatchObject({
      commandId: 'command-1',
      claimToken: 'claim-token-1',
      status: 'applied',
      entityId: 'card-1',
    });
  });

  test('returns an existing receipt without claiming or executing a replay', async () => {
    const deps = dependencies();
    deps.beginCommand.mockResolvedValue({
      command: { _id: 'command-1', status: 'applied', entityRevision: 8 },
      keyReused: false,
      created: false,
    });

    const response = await createMobileCommandPost(deps as any)(request());

    expect(await response.json()).toEqual({
      commandID: 'command-1',
      status: 'applied',
      entityRevision: 8,
    });
    expect(deps.claimCommand).not.toHaveBeenCalled();
    expect(deps.executeMobileCommand).not.toHaveBeenCalled();
  });

  test('uses the typed idempotency conflict response for key reuse', async () => {
    const deps = dependencies();
    deps.beginCommand.mockResolvedValue({
      command: { _id: 'command-1', status: 'queued' },
      keyReused: true,
      created: false,
    });

    const response = await createMobileCommandPost(deps as any)(request());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toEqual({
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: 'This idempotency key already belongs to a different command payload.',
      retryable: false,
    });
  });

  test('returns the current receipt when another worker owns the lease', async () => {
    const deps = dependencies();
    deps.claimCommand.mockResolvedValue({
      claimed: false,
      command: { _id: 'command-1', status: 'queued' },
    });

    const response = await createMobileCommandPost(deps as any)(request());

    expect(await response.json()).toEqual({ commandID: 'command-1', status: 'queued' });
    expect(deps.executeMobileCommand).not.toHaveBeenCalled();
  });

  test('rejects invalid command payloads before beginning a command', async () => {
    const deps = dependencies();

    const response = await createMobileCommandPost(deps as any)(
      request({ ...body, payload: { completed: true } }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_REQUEST');
    expect(deps.beginCommand).not.toHaveBeenCalled();
  });

  test('records an execution failure and returns its durable failed receipt', async () => {
    const deps = dependencies();
    deps.executeMobileCommand.mockImplementation(async () => {
      throw new Error('private provider failure');
    });

    const response = await createMobileCommandPost(deps as any)(request());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      commandID: 'command-1',
      status: 'failed',
      recoverableError: {
        code: 'SERVER_ERROR',
        message: 'The server could not complete the request.',
        retryable: true,
      },
    });
    expect(deps.completeCommand.mock.calls[0][0]).toMatchObject({
      status: 'failed',
      errorCode: 'SERVER_ERROR',
      errorMessage: 'The server could not complete the request.',
      errorRetryable: true,
    });
  });
});

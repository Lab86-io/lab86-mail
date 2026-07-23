import { describe, expect, mock, test } from 'bun:test';
import { createMobileCommandUndoPost } from '../app/api/mobile/v1/commands/[id]/undo/route';
import { UndoOperationInProgressError } from '../lib/ai/operations';

const user = {
  userId: 'undo_user',
  email: 'undo@example.test',
  name: 'Undo User',
  source: 'clerk' as const,
};

function request() {
  return new Request('http://localhost/api/mobile/v1/commands/command-1/undo', {
    method: 'POST',
    headers: { 'x-request-id': 'undo-request' },
  });
}

function context() {
  return { params: Promise.resolve({ id: 'command-1' }) };
}

function dependencies() {
  return {
    requireCurrentUser: mock(async () => user),
    claimCommandUndo: mock(async () => ({
      claimed: true,
      reason: 'claimed',
      command: { _id: 'command-1', status: 'applied', operationId: 'operation-1' },
    })) as any,
    completeCommandUndo: mock(async () => ({
      _id: 'command-1',
      status: 'applied',
      operationId: 'operation-1',
      undoneAt: Date.now(),
      entityRevision: 4,
    })) as any,
    releaseCommandUndo: mock(async () => undefined),
    undoOperation: mock(async () => undefined),
    randomUUID: () => 'undo-claim-1',
  };
}

describe('mobile command undo route', () => {
  test('claims, performs, and completes one undo', async () => {
    const deps = dependencies();

    const response = await createMobileCommandUndoPost(deps as any)(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      commandID: 'command-1',
      status: 'applied',
      entityRevision: 4,
      operationID: 'operation-1',
    });
    expect(deps.claimCommandUndo).toHaveBeenCalledWith({
      userId: user.userId,
      commandId: 'command-1',
      claimToken: 'undo-claim-1',
      leaseMs: 60_000,
    });
    expect(deps.undoOperation).toHaveBeenCalledWith(user.userId, 'operation-1');
    expect(deps.completeCommandUndo).toHaveBeenCalledWith({
      userId: user.userId,
      commandId: 'command-1',
      claimToken: 'undo-claim-1',
    });
  });

  test('a repeated undo returns its receipt without running the operation again', async () => {
    const deps = dependencies();
    const undoneAt = Date.now();
    deps.claimCommandUndo.mockResolvedValue({
      claimed: false,
      reason: 'already_undone',
      command: {
        _id: 'command-1',
        status: 'applied',
        operationId: 'operation-1',
        undoneAt,
        entityRevision: 4,
      },
    });

    const response = await createMobileCommandUndoPost(deps as any)(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      commandID: 'command-1',
      status: 'applied',
      entityRevision: 4,
      operationID: 'operation-1',
    });
    expect(deps.undoOperation).not.toHaveBeenCalled();
    expect(deps.completeCommandUndo).not.toHaveBeenCalled();
  });

  test('concurrent requests cannot execute the same operation twice', async () => {
    const deps = dependencies();
    let claimed = false;
    let signalStarted: (() => void) | undefined;
    let releaseUndo: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseUndo = resolve;
    });
    deps.claimCommandUndo.mockImplementation(async () => {
      if (claimed) {
        return {
          claimed: false,
          reason: 'in_progress',
          command: { _id: 'command-1', status: 'applied', operationId: 'operation-1' },
        };
      }
      claimed = true;
      return {
        claimed: true,
        reason: 'claimed',
        command: { _id: 'command-1', status: 'applied', operationId: 'operation-1' },
      };
    });
    deps.undoOperation.mockImplementation(async () => {
      signalStarted?.();
      await gate;
    });
    const post = createMobileCommandUndoPost(deps as any);

    const first = post(request(), context());
    await started;
    const second = await post(request(), context());
    releaseUndo?.();
    const firstResponse = await first;

    expect(firstResponse.status).toBe(200);
    expect(second.status).toBe(409);
    expect((await second.json()).error.message).toBe('Undo is already in progress.');
    expect(deps.undoOperation).toHaveBeenCalledTimes(1);
    expect(deps.completeCommandUndo).toHaveBeenCalledTimes(1);
  });

  test('maps missing, non-undoable, and expired claims to stable errors', async () => {
    for (const [reason, status, code, message] of [
      ['not_found', 404, 'NOT_FOUND', 'Mobile command not found.'],
      ['not_undoable', 409, 'CONFLICT', 'This mobile command is not undoable.'],
      ['expired', 409, 'CONFLICT', 'Undo window expired.'],
    ] as const) {
      const deps = dependencies();
      deps.claimCommandUndo.mockResolvedValue({ claimed: false, reason, command: null });

      const response = await createMobileCommandUndoPost(deps as any)(request(), context());
      const payload = await response.json();

      expect(response.status).toBe(status);
      expect(payload.error).toMatchObject({ code, message });
      expect(deps.undoOperation).not.toHaveBeenCalled();
    }
  });

  test('releases the lease after an undo failure so the command can be retried', async () => {
    const deps = dependencies();
    deps.undoOperation.mockImplementation(async () => {
      throw new Error('provider undo failed');
    });

    const response = await createMobileCommandUndoPost(deps as any)(request(), context());

    expect(response.status).toBe(500);
    expect(deps.releaseCommandUndo).toHaveBeenCalledWith({
      userId: user.userId,
      commandId: 'command-1',
      claimToken: 'undo-claim-1',
    });
    expect(deps.completeCommandUndo).not.toHaveBeenCalled();
  });

  test('maps an underlying provider-undo lease race to a retryable conflict', async () => {
    const deps = dependencies();
    deps.undoOperation.mockImplementation(async () => {
      throw new UndoOperationInProgressError();
    });

    const response = await createMobileCommandUndoPost(deps as any)(request(), context());

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({
      code: 'CONFLICT',
      message: 'This operation is already being undone.',
    });
    expect(deps.releaseCommandUndo).toHaveBeenCalledTimes(1);
    expect(deps.completeCommandUndo).not.toHaveBeenCalled();
  });
});

import { randomUUID } from 'node:crypto';
import { UndoOperationInProgressError, undoOperation } from '@/lib/ai/operations';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, type ConvexCallArgs, convexMutation } from '@/lib/hosted/convex';
import {
  MobileConflictError,
  MobileNotFoundError,
  mobileErrorResponse,
  mobileJSON,
  mobileRequestID,
} from '@/lib/mobile/v1/http';
import { commandReceiptFromRow } from '@/lib/mobile/v1/receipt';
import '@/lib/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UNDO_LEASE_MS = 60_000;

interface MobileCommandUndoDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  claimCommandUndo(args: ConvexCallArgs<typeof api.mobile.claimCommandUndo>): Promise<any>;
  completeCommandUndo(args: ConvexCallArgs<typeof api.mobile.completeCommandUndo>): Promise<any>;
  releaseCommandUndo(args: ConvexCallArgs<typeof api.mobile.releaseCommandUndo>): Promise<void>;
  undoOperation: typeof undoOperation;
  randomUUID: () => string;
}

const defaultDependencies: MobileCommandUndoDependencies = {
  requireCurrentUser,
  claimCommandUndo: (args) => convexMutation<any>(api.mobile.claimCommandUndo, args),
  completeCommandUndo: (args) => convexMutation<any>(api.mobile.completeCommandUndo, args),
  releaseCommandUndo: (args) => convexMutation<void>(api.mobile.releaseCommandUndo, args),
  undoOperation,
  randomUUID,
};

export function createMobileCommandUndoPost(deps: MobileCommandUndoDependencies = defaultDependencies) {
  return async function mobileCommandUndoPost(
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) {
    const requestID = mobileRequestID(request);
    try {
      const user = await deps.requireCurrentUser();
      const { id } = await context.params;
      const claimToken = deps.randomUUID();
      const claim = await deps.claimCommandUndo({
        userId: user.userId,
        commandId: id,
        claimToken,
        leaseMs: UNDO_LEASE_MS,
      });
      if (!claim.claimed) {
        switch (claim.reason) {
          case 'not_found':
            throw new MobileNotFoundError('Mobile command not found.');
          case 'not_undoable':
            throw new MobileConflictError('This mobile command is not undoable.');
          case 'expired':
            throw new MobileConflictError('Undo window expired.');
          case 'in_progress':
            throw new MobileConflictError('Undo is already in progress.');
          case 'already_undone':
            return mobileJSON(commandReceiptFromRow(claim.command), undefined, requestID);
          default:
            throw new MobileConflictError('This mobile command could not be undone.');
        }
      }
      try {
        await deps.undoOperation(user.userId, claim.command.operationId);
      } catch (error) {
        await deps
          .releaseCommandUndo({ userId: user.userId, commandId: id, claimToken })
          .catch(() => undefined);
        if (error instanceof UndoOperationInProgressError) {
          throw new MobileConflictError(error.message);
        }
        throw error;
      }
      const updated = await deps.completeCommandUndo({
        userId: user.userId,
        commandId: id,
        claimToken,
      });
      return mobileJSON(commandReceiptFromRow(updated), undefined, requestID);
    } catch (error) {
      return mobileErrorResponse(error, requestID);
    }
  };
}

export const POST = createMobileCommandUndoPost();

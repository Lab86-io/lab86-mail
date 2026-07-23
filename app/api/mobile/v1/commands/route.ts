import { randomUUID } from 'node:crypto';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { mobileCommandPayloadHash } from '@/lib/mobile/v1/canonical';
import { executeMobileCommand, mobileCommandDomain } from '@/lib/mobile/v1/command-executor';
import { MobileCommandSchema } from '@/lib/mobile/v1/contract';
import {
  MobileIdempotencyConflictError,
  mapMobileHTTPError,
  mobileErrorResponse,
  mobileJSON,
  mobileRequestID,
} from '@/lib/mobile/v1/http';
import { commandReceiptFromRow } from '@/lib/mobile/v1/receipt';
import { enforceUserRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const EXECUTION_LEASE_MS = 5 * 60_000;

interface MobileCommandDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  beginCommand(args: Record<string, unknown>): Promise<any>;
  claimCommand(args: Record<string, unknown>): Promise<any>;
  completeCommand(args: Record<string, unknown>): Promise<any>;
  executeMobileCommand: typeof executeMobileCommand;
  randomUUID: () => string;
}

const defaultDependencies: MobileCommandDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  beginCommand: (args) => convexMutation<any>((api as any).mobile.beginCommand, args),
  claimCommand: (args) => convexMutation<any>((api as any).mobile.claimCommand, args),
  completeCommand: (args) => convexMutation<any>((api as any).mobile.completeCommand, args),
  executeMobileCommand,
  randomUUID,
};

export function createMobileCommandPost(deps: MobileCommandDependencies = defaultDependencies) {
  return async function mobileCommandPost(request: Request) {
    const requestID = mobileRequestID(request);
    try {
      const user = await deps.requireCurrentUser();
      const command = MobileCommandSchema.parse(await request.json());
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: `mobile-command:${command.kind}`,
        limit: 120,
        windowMs: 60_000,
      });
      const domain = mobileCommandDomain(command);
      const begun = await deps.beginCommand({
        userId: user.userId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: mobileCommandPayloadHash(command),
        domain,
        kind: command.kind,
        payload: command.payload,
        baseRevision: command.baseRevision,
        clientCreatedAt: command.clientCreatedAt,
      });
      if (begun.keyReused) {
        throw new MobileIdempotencyConflictError(
          'This idempotency key already belongs to a different command payload.',
        );
      }
      if (!begun.command || begun.command.status !== 'queued') {
        return mobileJSON(commandReceiptFromRow(begun.command), undefined, requestID);
      }
      const claimToken = deps.randomUUID();
      const claimed = await deps.claimCommand({
        userId: user.userId,
        commandId: begun.command._id,
        claimToken,
        leaseMs: EXECUTION_LEASE_MS,
      });
      if (!claimed.claimed) {
        return mobileJSON(commandReceiptFromRow(claimed.command), undefined, requestID);
      }
      try {
        const execution = await deps.executeMobileCommand(command, user);
        const completed = await deps.completeCommand({
          userId: user.userId,
          commandId: begun.command._id,
          claimToken,
          status: execution.status,
          syncDomain: execution.syncDomain,
          entityKind: execution.entityKind,
          entityId: execution.entityID,
          syncPayload: execution.syncPayload,
          operationId: execution.operationID,
          approvalId: execution.approvalID,
          undoExpiresAt: execution.undoExpiresAt,
        });
        return mobileJSON(commandReceiptFromRow(completed), undefined, requestID);
      } catch (error) {
        const mapped = mapMobileHTTPError(error);
        const failed = await deps.completeCommand({
          userId: user.userId,
          commandId: begun.command._id,
          claimToken,
          status: 'failed',
          errorCode: mapped.code.slice(0, 100),
          errorMessage: mapped.message.slice(0, 1_000),
          errorRetryable: mapped.retryable,
        });
        return mobileJSON(commandReceiptFromRow(failed), undefined, requestID);
      }
    } catch (error) {
      return mobileErrorResponse(error, requestID);
    }
  };
}

export const POST = createMobileCommandPost();

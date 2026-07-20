import { randomUUID } from 'node:crypto';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { mobileCommandPayloadHash } from '@/lib/mobile/v1/canonical';
import { executeMobileCommand, mobileCommandDomain } from '@/lib/mobile/v1/command-executor';
import { MobileCommandSchema } from '@/lib/mobile/v1/contract';
import { mapMobileHTTPError, mobileErrorResponse, mobileJSON, mobileRequestID } from '@/lib/mobile/v1/http';
import { commandReceiptFromRow } from '@/lib/mobile/v1/receipt';
import { enforceUserRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const EXECUTION_LEASE_MS = 5 * 60_000;

export async function POST(request: Request) {
  const requestID = mobileRequestID(request);
  try {
    const user = await requireCurrentUser();
    const command = MobileCommandSchema.parse(await request.json());
    await enforceUserRateLimit({
      userId: user.userId,
      key: `mobile-command:${command.kind}`,
      limit: 120,
      windowMs: 60_000,
    });
    const domain = mobileCommandDomain(command);
    const begun = await convexMutation<any>((api as any).mobile.beginCommand, {
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
      return mobileJSON(
        {
          ok: false,
          requestID,
          error: {
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'This idempotency key already belongs to a different command payload.',
            retryable: false,
          },
        },
        { status: 409 },
        requestID,
      );
    }
    if (!begun.command || begun.command.status !== 'queued') {
      return mobileJSON(commandReceiptFromRow(begun.command), undefined, requestID);
    }
    const claimToken = randomUUID();
    const claimed = await convexMutation<any>((api as any).mobile.claimCommand, {
      userId: user.userId,
      commandId: begun.command._id,
      claimToken,
      leaseMs: EXECUTION_LEASE_MS,
    });
    if (!claimed.claimed) {
      return mobileJSON(commandReceiptFromRow(claimed.command), undefined, requestID);
    }
    try {
      const execution = await executeMobileCommand(command, user);
      const completed = await convexMutation<any>((api as any).mobile.completeCommand, {
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
      const failed = await convexMutation<any>((api as any).mobile.completeCommand, {
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
}

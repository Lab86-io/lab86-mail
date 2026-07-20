import { undoOperation } from '@/lib/ai/operations';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { MobileConflictError, mobileErrorResponse, mobileJSON, mobileRequestID } from '@/lib/mobile/v1/http';
import { commandReceiptFromRow } from '@/lib/mobile/v1/receipt';
import '@/lib/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestID = mobileRequestID(request);
  try {
    const user = await requireCurrentUser();
    const { id } = await context.params;
    const command = await convexQuery<any | null>((api as any).mobile.getCommand, {
      userId: user.userId,
      commandId: id,
    });
    if (!command) throw new MobileConflictError('Mobile command not found.');
    if (!command.operationId) throw new MobileConflictError('This mobile command is not undoable.');
    if (command.undoExpiresAt && Date.now() > command.undoExpiresAt) {
      throw new MobileConflictError('Undo window expired.');
    }
    if (!command.undoneAt) {
      await undoOperation(user.userId, command.operationId);
    }
    const updated = await convexMutation<any>((api as any).mobile.markCommandUndone, {
      userId: user.userId,
      commandId: id,
    });
    return mobileJSON(commandReceiptFromRow(updated), undefined, requestID);
  } catch (error) {
    return mobileErrorResponse(error, requestID);
  }
}

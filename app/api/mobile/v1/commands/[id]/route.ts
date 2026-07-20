import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { mobileErrorResponse, mobileJSON, mobileRequestID } from '@/lib/mobile/v1/http';
import { commandReceiptFromRow } from '@/lib/mobile/v1/receipt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestID = mobileRequestID(request);
  try {
    const user = await requireCurrentUser();
    const { id } = await context.params;
    const command = await convexQuery<any | null>((api as any).mobile.getCommand, {
      userId: user.userId,
      commandId: id,
    });
    if (!command) {
      return mobileJSON(
        {
          ok: false,
          requestID,
          error: { code: 'NOT_FOUND', message: 'Mobile command not found.', retryable: false },
        },
        { status: 404 },
        requestID,
      );
    }
    return mobileJSON(commandReceiptFromRow(command), undefined, requestID);
  } catch (error) {
    return mobileErrorResponse(error, requestID);
  }
}

import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { MobileNotFoundError, mobileErrorResponse, mobileJSON, mobileRequestID } from '@/lib/mobile/v1/http';
import { commandReceiptFromRow } from '@/lib/mobile/v1/receipt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface MobileCommandGetDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  getCommand(args: { userId: string; commandId: string }): Promise<any | null>;
}

const defaultDependencies: MobileCommandGetDependencies = {
  requireCurrentUser,
  getCommand: (args) => convexQuery<any | null>((api as any).mobile.getCommand, args),
};

export function createMobileCommandGet(deps: MobileCommandGetDependencies = defaultDependencies) {
  return async function mobileCommandGet(request: Request, context: { params: Promise<{ id: string }> }) {
    const requestID = mobileRequestID(request);
    try {
      const user = await deps.requireCurrentUser();
      const { id } = await context.params;
      const command = await deps.getCommand({ userId: user.userId, commandId: id });
      if (!command) throw new MobileNotFoundError('Mobile command not found.');
      return mobileJSON(commandReceiptFromRow(command), undefined, requestID);
    } catch (error) {
      return mobileErrorResponse(error, requestID);
    }
  };
}

export const GET = createMobileCommandGet();

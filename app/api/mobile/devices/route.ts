import type { NextRequest } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import {
  MobileDeviceInputError,
  parseMobileDeviceRegistration,
  parseMobileDeviceRevocation,
} from '@/lib/notifications/mobile-device';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorResponse(error: unknown, reportUnexpectedError: (error: unknown) => void) {
  const status =
    error instanceof AuthRequiredError
      ? 401
      : error instanceof MobileDeviceInputError || error instanceof SyntaxError
        ? 400
        : 500;
  const message =
    error instanceof AuthRequiredError || error instanceof MobileDeviceInputError
      ? error.message
      : error instanceof SyntaxError
        ? 'Request body must be valid JSON.'
        : 'Push device update failed.';
  if (status === 500) reportUnexpectedError(error);
  return Response.json({ ok: false, error: message }, { status });
}

interface MobileDeviceDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  convexMutation: typeof convexMutation;
  parseMobileDeviceRegistration: typeof parseMobileDeviceRegistration;
  parseMobileDeviceRevocation: typeof parseMobileDeviceRevocation;
  reportUnexpectedError: (error: unknown) => void;
}

const defaultDependencies: MobileDeviceDependencies = {
  requireCurrentUser,
  convexMutation,
  parseMobileDeviceRegistration,
  parseMobileDeviceRevocation,
  reportUnexpectedError: (error) => console.error('Push device update failed.', error),
};

export function createMobileDeviceHandlers(deps: MobileDeviceDependencies = defaultDependencies) {
  async function post(req: NextRequest) {
    try {
      const user = await deps.requireCurrentUser();
      const registration = deps.parseMobileDeviceRegistration(await req.json());
      const deviceId = await deps.convexMutation<string>(
        (api as any).albatrossNotifications.upsertMobileDevice,
        {
          userId: user.userId,
          ...registration,
        },
      );
      return Response.json({ ok: true, deviceId });
    } catch (error) {
      return errorResponse(error, deps.reportUnexpectedError);
    }
  }

  async function remove(req: NextRequest) {
    try {
      const user = await deps.requireCurrentUser();
      const revocation = deps.parseMobileDeviceRevocation(await req.json());
      const result = await deps.convexMutation<{ revoked: number }>(
        (api as any).albatrossNotifications.revokeMobileDevice,
        { userId: user.userId, ...revocation },
      );
      return Response.json({ ok: true, revoked: result.revoked });
    } catch (error) {
      return errorResponse(error, deps.reportUnexpectedError);
    }
  }

  return { POST: post, DELETE: remove };
}

export const { POST, DELETE } = createMobileDeviceHandlers();

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

function errorResponse(error: unknown) {
  const status =
    error instanceof AuthRequiredError ? 401 : error instanceof MobileDeviceInputError ? 400 : 500;
  return Response.json(
    { ok: false, error: error instanceof Error ? error.message : 'Push registration failed.' },
    { status },
  );
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    const registration = parseMobileDeviceRegistration(await req.json());
    const deviceId = await convexMutation<string>((api as any).albatrossNotifications.upsertMobileDevice, {
      userId: user.userId,
      ...registration,
    });
    return Response.json({ ok: true, deviceId });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    const revocation = parseMobileDeviceRevocation(await req.json());
    const result = await convexMutation<{ revoked: number }>(
      (api as any).albatrossNotifications.revokeMobileDevice,
      { userId: user.userId, ...revocation },
    );
    return Response.json({ ok: true, revoked: result.revoked });
  } catch (error) {
    return errorResponse(error);
  }
}

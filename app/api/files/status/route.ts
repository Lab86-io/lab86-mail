import { NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { listCloudFileConnections } from '@/lib/files/connections';
import {
  CLOUD_FILE_PROVIDER_DEFINITIONS,
  CLOUD_FILE_PROVIDERS,
  cloudFileProviderIsConfigured,
} from '@/lib/files/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireCurrentUser();
    const connections = await listCloudFileConnections(user.userId);
    return NextResponse.json({
      ok: true,
      connections,
      providers: CLOUD_FILE_PROVIDERS.map((id) => ({
        id,
        label: CLOUD_FILE_PROVIDER_DEFINITIONS[id].label,
        configured: cloudFileProviderIsConfigured(id),
      })),
      icloud: {
        mode: 'device_folder',
        detail:
          'Choose an iCloud Drive folder from this device. It is not uploaded or indexed on the server.',
      },
    });
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
    }
    console.error('[files/status] failed', error);
    return NextResponse.json({ ok: false, error: 'Could not load file connections.' }, { status: 500 });
  }
}

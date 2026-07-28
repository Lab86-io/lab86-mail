import { NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { disconnectCloudFileConnection } from '@/lib/files/connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const user = await requireCurrentUser();
    const body = (await req.json().catch(() => ({}))) as {
      connectionId?: string;
    };
    const connectionId = String(body.connectionId || '').trim();
    if (!connectionId) {
      return NextResponse.json({ ok: false, error: 'connectionId required' }, { status: 400 });
    }
    await disconnectCloudFileConnection(user.userId, connectionId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
    }
    console.error('[files/disconnect] failed', error);
    return NextResponse.json({ ok: false, error: 'Could not disconnect file provider.' }, { status: 500 });
  }
}

import { type NextRequest, NextResponse } from 'next/server';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { refreshNarrative } from '@/lib/narrative/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export async function POST(req: NextRequest) {
  if (!isInternalCronRequest(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.userId !== 'string' || !body.userId)
    return NextResponse.json({ error: 'User required' }, { status: 400 });
  // Await the full run. A cron never acknowledges an in-memory-only background job.
  try {
    return NextResponse.json(await refreshNarrative(body.userId, 'scheduled'));
  } catch {
    return NextResponse.json({ error: 'Narrative refresh failed' }, { status: 500 });
  }
}

import { type NextRequest, NextResponse } from 'next/server';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { enqueueBriefJob } from '@/lib/mail/brief-jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: NextRequest) {
  if (!isInternalCronRequest(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.userId !== 'string' || !body.userId)
    return NextResponse.json({ error: 'User required' }, { status: 400 });
  // Acknowledge only after the recoverable job is persisted.
  try {
    return NextResponse.json(await enqueueBriefJob({ userId: body.userId, kind: 'narrative' }), {
      status: 202,
    });
  } catch {
    return NextResponse.json({ error: 'Narrative refresh failed' }, { status: 500 });
  }
}

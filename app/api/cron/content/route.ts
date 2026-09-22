import { after, type NextRequest, NextResponse } from 'next/server';
import { kickContentCycle } from '@/lib/content/sync';
import { isInternalCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export async function POST(req: NextRequest) {
  if (!isInternalCronRequest(req)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (typeof body?.userId !== 'string' || !body.userId.trim() || body.userId.length > 240)
    return NextResponse.json({ error: 'User is required.' }, { status: 400 });
  after(async () => {
    await kickContentCycle(body.userId);
  });
  return NextResponse.json({ started: true }, { status: 202 });
}

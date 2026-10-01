import { type NextRequest, NextResponse } from 'next/server';
import { handleChannelPush } from '@/lib/google/push/receive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Google Calendar channel messages (docs/google-direct-transport.md, "Push").
// handleChannelPush checks X-Goog-Channel-ID, X-Goog-Channel-Token, and
// X-Goog-Resource-ID against the stored channel. The answer is always 204,
// so Google does not send a message again; with LAB86_GOOGLE_CALENDAR_PUSH
// off, nothing runs.
export async function POST(req: NextRequest) {
  const result = handleChannelPush('calendar', req.headers);
  return new NextResponse(null, { status: result.status });
}

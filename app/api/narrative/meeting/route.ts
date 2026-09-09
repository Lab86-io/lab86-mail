import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { MeetingContextError, meetingInput, prepareNarrativeMeeting } from '@/lib/narrative/meeting-prep';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const defaults = { user: requireCurrentUser, prepare: prepareNarrativeMeeting, rate: enforceUserRateLimit };
export function createNarrativeMeetingPost(deps = defaults) {
  return async (request: NextRequest) => {
    try {
      const user = await deps.user();
      const selector = meetingInput.parse(await request.json().catch(() => null));
      await deps.rate({ userId: user.userId, key: 'narrative-meeting', limit: 12, windowMs: 60_000 });
      return NextResponse.json(await deps.prepare(user.userId, selector, request.signal), {
        headers: { 'cache-control': 'private, no-store' },
      });
    } catch (error) {
      if (error instanceof AuthRequiredError)
        return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
      if (error instanceof RateLimitError) return rateLimitJson(error);
      if (error instanceof z.ZodError)
        return NextResponse.json({ error: 'Select a synced calendar event first.' }, { status: 400 });
      if (error instanceof MeetingContextError)
        return NextResponse.json({ error: error.message }, { status: error.status });
      console.error('[narrative] meeting prep failed', {
        name: error instanceof Error ? error.name : 'UnknownError',
      });
      return NextResponse.json(
        { error: 'Meeting prep is unavailable. Your calendar is unchanged.' },
        { status: 503 },
      );
    }
  };
}
export const POST = createNarrativeMeetingPost();

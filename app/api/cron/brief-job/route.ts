import { after, type NextRequest, NextResponse } from 'next/server';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { runBriefJob } from '@/lib/mail/brief-jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const defaults = { authorized: isInternalCronRequest, after, run: runBriefJob };
export function createBriefJobPost(deps = defaults) {
  return async (request: NextRequest) => {
    if (!deps.authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await request.json().catch(() => null);
    if (typeof body?.userId !== 'string' || !body.userId || typeof body?.id !== 'string' || !body.id)
      return NextResponse.json({ error: 'Job required' }, { status: 400 });
    deps.after(() => deps.run(body.userId, body.id));
    return NextResponse.json({ accepted: true }, { status: 202 });
  };
}
export const POST = createBriefJobPost();

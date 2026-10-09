import { type NextRequest, NextResponse } from 'next/server';
import { describeModelError } from '@/lib/ai/log-error';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { reportAtlassianPersonalData } from '@/lib/mcp/atlassian-privacy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const defaultDeps = { isInternalCronRequest, reportAtlassianPersonalData };

// Called once a day by the Convex Atlassian privacy cron (convex/mcpSync.ts)
// for one user with an Atlassian sign-in. Reports that user's Atlassian
// accounts to the Atlassian personal data reporting API.
export function createAtlassianPrivacyPost(deps: typeof defaultDeps = defaultDeps) {
  return async function atlassianPrivacyPost(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    const body = (await req.json().catch(() => ({}))) as { userId?: unknown };
    const userId = String(body?.userId || '').trim();
    if (!userId) {
      return NextResponse.json({ ok: false, error: 'userId is required.' }, { status: 400 });
    }
    try {
      const results = await deps.reportAtlassianPersonalData(userId);
      return NextResponse.json({ ok: true, userId, results });
    } catch (error) {
      console.error('[cron/atlassian-privacy] report failed', userId, describeModelError(error));
      return NextResponse.json({ ok: false, error: 'Report failed.' }, { status: 500 });
    }
  };
}

export const POST = createAtlassianPrivacyPost();

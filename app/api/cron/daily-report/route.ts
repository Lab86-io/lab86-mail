import { type NextRequest, NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { generateAgentReport } from '@/lib/mail/agent-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Artifact generation runs for several seconds; allow a long ceiling even
// though we return early (the work continues on the persistent server).
export const maxDuration = 300;

// Called by the Convex hourly cron (convex/dailyReports.ts) for one user when
// their local clock hits the morning/evening hour. AI + Nylas live in the app,
// not in Convex, so the schedule fans out to this internal-secret-gated route.
function authorized(req: NextRequest): boolean {
  const expected = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  if (!expected) return false;
  const provided =
    req.headers.get('x-lab86-internal-secret') ||
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    '';
  return provided === expected;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
  }
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // empty/invalid body handled below
  }
  const userId = String(body?.userId || '').trim();
  const kind = body?.kind === 'morning' || body?.kind === 'evening' ? body.kind : 'manual';
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'userId is required.' }, { status: 400 });
  }

  // Railway runs a persistent Node server, so this background promise outlives
  // the response — we ACK immediately rather than holding the cron's request
  // open for the full multi-second generation.
  void runWithAiRequestContext({ userId, agent: 'ai' }, () =>
    generateAgentReport({ kind, userId }).catch((err) => {
      console.error('[cron/daily-report] generation failed', userId, kind, err);
    }),
  );
  return NextResponse.json({ ok: true, started: true, userId, kind }, { status: 202 });
}

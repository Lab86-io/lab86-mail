import { type NextRequest, NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { classifyIntents, classifyThreads } from '@/lib/albatross/area-classifier';
import { classifyAreaArtifacts } from '@/lib/albatross/area-discovery';
import { isInternalCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Called by the Convex area-classify cron (convex/albatross.ts classifyTick)
// for one user. The classifier runs bounded work — indexed reads plus at most
// three independent fast-model calls (mail threads, cross-source discovery,
// captured intents) — so the route awaits them all and reports the counts.
export async function POST(req: NextRequest) {
  if (!isInternalCronRequest(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
  }
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // empty/invalid body handled below
  }
  const userId = String(body?.userId || '').trim();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'userId is required.' }, { status: 400 });
  }
  try {
    const counts = await runWithAiRequestContext({ userId, agent: 'ai' }, async () => {
      const [mail, connected, intents] = await Promise.all([
        classifyThreads({ userId }),
        classifyAreaArtifacts({ userId }),
        classifyIntents({ userId }),
      ]);
      return { mail, connected, intents };
    });
    return NextResponse.json({ ok: true, userId, ...counts }, { status: 200 });
  } catch (err: any) {
    console.error('[cron/area-classify] classification failed', userId, err);
    return NextResponse.json(
      { ok: false, error: err?.message || 'area classification failed', userId },
      { status: 500 },
    );
  }
}

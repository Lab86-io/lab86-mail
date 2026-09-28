import { after, type NextRequest, NextResponse } from 'next/server';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { runCostAlarm } from '@/lib/notifications/cost-alarm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultDependencies = { isInternalCronRequest, runCostAlarm, after };

// Called each hour by the Convex cost alarm cron (convex/aiCostAlarm.ts
// tick). Runs in the background and only sends an email to the owner.
export function createCostAlarmPost(overrides: Partial<typeof defaultDependencies> = {}) {
  const deps = { ...defaultDependencies, ...overrides };
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    // after() keeps the run alive once the 202 is sent, so the host cannot
    // stop it between the day claim and the email.
    deps.after(() =>
      deps
        .runCostAlarm()
        .then((run) => {
          if (run.status === 'ran' && (run.sent || run.failed)) console.info('[cron/cost-alarm]', run);
        })
        .catch((err) => {
          console.error('[cron/cost-alarm] run failed', err);
        }),
    );
    return NextResponse.json({ ok: true, started: true }, { status: 202 });
  };
}

export const POST = createCostAlarmPost();

import { after, type NextRequest, NextResponse } from 'next/server';
import { describeModelError } from '@/lib/ai/log-error';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { runOpsAlarm } from '@/lib/notifications/ops-alarm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultDependencies = { isInternalCronRequest, runOpsAlarm, after };

// Called each 15 minutes by the Convex failure alarm cron (convex/opsHealth.ts
// tick). Runs in the background and only sends an email to the owner.
export function createOpsHealthPost(overrides: Partial<typeof defaultDependencies> = {}) {
  const deps = { ...defaultDependencies, ...overrides };
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    // after() keeps the run alive once the 202 is sent, so the host cannot
    // stop it between the claim and the email.
    deps.after(() =>
      deps
        .runOpsAlarm()
        .then((run) => {
          if (run.status === 'ran' && (run.sent || run.failed)) console.info('[cron/ops-health]', run);
        })
        .catch((err) => {
          console.error('[cron/ops-health] run failed', describeModelError(err));
        }),
    );
    return NextResponse.json({ ok: true, started: true }, { status: 202 });
  };
}

export const POST = createOpsHealthPost();

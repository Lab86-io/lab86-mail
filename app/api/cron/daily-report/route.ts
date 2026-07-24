import { type NextRequest, NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { isStagingRuntime } from '@/lib/hosted/controls';
import { api, convexMutation } from '@/lib/hosted/convex';
import { generateAgentReport } from '@/lib/mail/agent-report';
import { dispatchNativeNotification } from '@/lib/notifications/native-delivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Artifact generation runs for several seconds; allow a long ceiling so the
// scheduled edition is fully written before the cron call is acknowledged.
export const maxDuration = 300;

interface DailyReportCronDependencies {
  isInternalCronRequest: (request: NextRequest) => boolean;
  isStagingRuntime: (host: string | null) => boolean;
  generateReport: (input: {
    userId: string;
    kind: 'morning' | 'evening' | 'manual';
    userTimezone?: string;
  }) => Promise<any>;
  queueBriefReady: (input: { userId: string; reportId: string; localDate: string }) => Promise<any>;
  dispatchNativeNotification: (userId: string, notificationId: string) => Promise<unknown>;
}

const defaultDependencies: DailyReportCronDependencies = {
  isInternalCronRequest,
  isStagingRuntime,
  generateReport: ({ userId, kind, userTimezone }) =>
    runWithAiRequestContext({ userId, agent: 'ai', userTimezone }, () =>
      generateAgentReport({ kind, userId }),
    ),
  queueBriefReady: ({ userId, reportId, localDate }) =>
    convexMutation<any>((api as any).albatrossNotifications.queueBriefReady, {
      userId,
      reportId,
      localDate,
    }),
  dispatchNativeNotification,
};

export function localDateForTimezone(generatedAt: number, timezone?: string) {
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(new Date(generatedAt))
    .reduce<Record<string, string>>((parts, part) => {
      if (part.type !== 'literal') parts[part.type] = part.value;
      return parts;
    }, {});
  return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
}

// Called by the Convex hourly cron (convex/dailyReports.ts) for one user when
// their local clock hits the morning/evening hour. AI + Nylas live in the app,
// not in Convex, so the schedule fans out to this internal-secret-gated route.
export function createDailyReportPost(deps: DailyReportCronDependencies = defaultDependencies) {
  return async function post(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
    if (deps.isStagingRuntime(host)) {
      return NextResponse.json({ ok: true, skipped: true, reason: 'staging' }, { status: 200 });
    }
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      // empty/invalid body handled below
    }
    const userId = String(body?.userId || '').trim();
    const kind = body?.kind === 'morning' || body?.kind === 'evening' ? body.kind : 'manual';
    // The cron passes each user's calendar timezone so the brief's dateline is local.
    const userTimezone = typeof body?.timezone === 'string' ? body.timezone : undefined;
    if (!userId) {
      return NextResponse.json({ ok: false, error: 'userId is required.' }, { status: 400 });
    }

    try {
      const report = await deps.generateReport({ kind, userId, userTimezone });
      let briefNotification: unknown;
      if (kind === 'morning') {
        try {
          const localDate = localDateForTimezone(report.generatedAt, userTimezone);
          const queued = await deps.queueBriefReady({
            userId,
            reportId: report._id,
            localDate,
          });
          briefNotification = queued?.notificationId
            ? await deps.dispatchNativeNotification(userId, String(queued.notificationId))
            : { skipped: queued?.skipped || 'not_queued' };
        } catch (notificationError) {
          console.error('[cron/daily-report] brief-ready notification failed', userId, notificationError);
          briefNotification = { failed: true };
        }
      }
      return NextResponse.json(
        {
          ok: true,
          started: false,
          userId,
          kind,
          reportId: report._id,
          artifactStatus: report.artifactStatus,
          briefNotification,
        },
        { status: 200 },
      );
    } catch (err: any) {
      console.error('[cron/daily-report] generation failed', userId, kind, err);
      return NextResponse.json(
        { ok: false, error: err?.message || 'daily report generation failed', userId, kind },
        { status: 500 },
      );
    }
  };
}

export const POST = createDailyReportPost();

import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

export const CONTINUOUS_EXECUTION_CRON_NAMES = {
  scheduling: 'Work scheduling conductor',
  reflection: 'check-in reflection reconciliation',
  tomorrow: 'tomorrow planning conductor',
  evidence: 'evidence reconciliation conductor',
  mailWatch: 'step mail watch conductor',
  recovery: 'passed block recovery',
  review: 'shape-aware Work review',
  wake: 'horizon wake',
} as const;

// Classify corpus threads that predate write-time classification (and any row
// a writer ever missed). The mutation chains itself while full batches keep
// coming back, so this cron is just the ignition; once the backlog is empty it
// is a single cheap indexed read per run.
crons.interval('classify unclassified corpus threads', { minutes: 10 }, internal.smart.classifyBacklog, {});

// File the morning Daily Brief. Runs at the top of every hour and fires
// per-user when their local clock hits 07:00 — the action reads each user's
// calendar timezone and calls back into the app to generate. (Mornings only;
// manual generation covers the rest.)
crons.hourly('daily report editions', { minuteUTC: 0 }, internal.dailyReports.tick, {});

// Poll each connected user's calendars for changes every 15 minutes — a
// safety net over the webhook-driven event deltas.
crons.interval('calendar resync', { minutes: 15 }, internal.calendarSync.tick, {});

// File new mail threads into the user's areas every 30 minutes: deterministic
// fact matches first, then one nano-LLM verdict for the rest (candidate-only).
crons.interval('area classify', { minutes: 30 }, internal.albatross.classifyTick, {});
// Shapes for Work captured before shapes existed. Each pass reads only
// unshaped Work, so the job does less every hour and then does nothing.
crons.interval('shape backfill', { hours: 1 }, internal.albatross.shapeBackfillTick, {});

// Unstick intent plans whose generation was killed mid-flight (deploys
// replace the Next container; SIGTERM skips the planError catch). Re-kicks
// stale 'planning' intents through the app, then fails them gracefully.
crons.interval('plan reconcile', { minutes: 5 }, internal.albatrossIntents.planReconcileTick, {});

// Keep concrete Work scheduled. Existing or passed blocks are authoritative;
// only never-scheduled plans enter this loop, with a six-hour retry lease.
crons.interval(
  CONTINUOUS_EXECUTION_CRON_NAMES.scheduling,
  { minutes: 15 },
  internal.albatrossIntents.conductorTick,
  {},
);

// Local-time Albatross check-ins and their multi-channel delivery outbox.
// Each target is deduped by user + local date, so a 15-minute cadence remains
// safe across deploys, retries, and daylight-saving transitions.
crons.interval('albatross notifications', { minutes: 15 }, internal.albatrossNotifications.tick, {});

// Check-in writes return as soon as Convex owns the user's words. These two
// conductors perform the slower interpretation and tomorrow planning without
// making mobile keep a sheet open for an AI round-trip.
crons.interval(
  CONTINUOUS_EXECUTION_CRON_NAMES.reflection,
  { minutes: 2 },
  internal.albatrossNotifications.reflectionReconcileTick,
  {},
);
crons.interval(
  CONTINUOUS_EXECUTION_CRON_NAMES.tomorrow,
  { minutes: 2 },
  internal.albatrossNotifications.tomorrowPlanTick,
  {},
);

// Proof can arrive from Mail or chat while no Work surface is open. Advance
// that Work asynchronously, after the evidence itself is safely stored.
crons.interval(
  CONTINUOUS_EXECUTION_CRON_NAMES.evidence,
  { minutes: 5 },
  internal.albatrossWorkV2.evidenceReconcileTick,
  {},
);

// A step that expects a mail confirmation watches the inbox through a poll:
// recent confirmable threads meet the evidence gate, and a receipt checks the
// step off with the thread bound as step evidence.
crons.interval(
  CONTINUOUS_EXECUTION_CRON_NAMES.mailWatch,
  { minutes: 15 },
  internal.albatrossWorkV2.mailWatchTick,
  {},
);

// Passed calendar blocks and shape-aware quiet Work are separate signals: one
// needs a recovery choice now; the other deserves an occasional review.
crons.interval(
  CONTINUOUS_EXECUTION_CRON_NAMES.recovery,
  { minutes: 5 },
  internal.albatrossNotifications.missedMoveTick,
  {},
);
crons.hourly(
  CONTINUOUS_EXECUTION_CRON_NAMES.review,
  { minuteUTC: 23 },
  internal.albatrossNotifications.stalenessReviewTick,
  {},
);

// Dormant Work wakes once, on its own date, with one calm line. The daily
// pass runs at 12:00 UTC so a "November 1" sleep ends in the US morning.
crons.daily(
  CONTINUOUS_EXECUTION_CRON_NAMES.wake,
  { hourUTC: 12, minuteUTC: 0 },
  internal.albatrossWorkV2.horizonWakeTick,
  {},
);

// Project-scoped routines materialize durable tasks, questions, and in-app
// notifications. Stable local-date run keys make this safe across retries,
// deploys, and DST transitions.
crons.interval('albatross routines', { minutes: 5 }, internal.albatrossRoutines.tick, {});

// Additive Work-v2 migration is idempotent and paginates through legacy
// intents. Re-igniting it twice daily also catches rows written by an older
// client during the compatibility window.
crons.interval('albatross Work v2 migration', { hours: 12 }, internal.albatrossWorkV2.migrateLegacyBatch, {
  limit: 100,
});

// Poll each user's connected tool servers/APIs every 20 minutes
// so brief/search items stay current. Cast: the generated `internal` type only
// gains `mcpSync` after codegen on deploy.
crons.interval('mcp sync', { minutes: 20 }, (internal as any).mcpSync.tick, {});

// Disconnect normally schedules its own bounded cleanup chain. This sweep is
// the recovery path if a deploy interrupts that chain between batches.
crons.interval(
  'mcp disconnect cleanup',
  { minutes: 30 },
  (internal as any).mcp.sweepDisconnectedConnections,
  {},
);

crons.interval('mcp oauth state cleanup', { minutes: 30 }, internal.mcp.sweepExpiredOAuthStates, {});

export default crons;

import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

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

export default crons;

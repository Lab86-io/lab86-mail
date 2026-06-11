import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// Classify corpus threads that predate write-time classification (and any row
// a writer ever missed). The mutation chains itself while full batches keep
// coming back, so this cron is just the ignition; once the backlog is empty it
// is a single cheap indexed read per run.
crons.interval('classify unclassified corpus threads', { minutes: 10 }, internal.smart.classifyBacklog, {});

export default crons;

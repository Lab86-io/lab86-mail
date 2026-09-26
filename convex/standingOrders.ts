import { v } from 'convex/values';
import { nextRoutineRunAt } from '../lib/albatross/routines';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

// Reads and writes behind Settings, Standing orders. Each list is bounded: the
// page shows what runs on its own, not a full history.

const LIST_LIMIT = 50;
const WATCH_STATES = ['active', 'waiting', 'blocked'] as const;

export const overview = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const routineRows = await ctx.db
      .query('albatrossRoutines')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .take(200);
    const routines = [];
    for (const routine of routineRows) {
      // Only routines the user agreed to are standing orders. A proposal is a
      // question, and a declined or archived routine does not run.
      if (routine.consent !== 'enabled' || routine.status === 'archived') continue;
      const project = await ctx.db.get(routine.projectId);
      routines.push({
        id: String(routine._id),
        title: routine.title,
        kind: routine.kind,
        cadence: routine.cadence,
        daysOfWeek: routine.daysOfWeek ?? null,
        localTime: routine.localTime,
        timezone: routine.timezone,
        paused: routine.status === 'paused',
        nextRunAt: routine.status === 'active' ? routine.nextRunAt : null,
        projectTitle: project && project.userId === args.userId ? project.title : null,
      });
      if (routines.length >= LIST_LIMIT) break;
    }

    const watches = [];
    for (const state of WATCH_STATES) {
      const rows = await ctx.db
        .query('albatrossIntents')
        .withIndex('by_user_work_state', (q) => q.eq('userId', args.userId).eq('workState', state))
        .take(200);
      for (const row of rows) {
        const reply = Boolean(row.replyWatch && row.workState === 'waiting');
        const step = typeof row.mailWatchAt === 'number' && row.mailWatchAt > 0;
        if (!reply && !step) continue;
        watches.push({
          workId: String(row._id),
          title: row.title || row.rawText.slice(0, 120),
          kind: reply ? ('reply' as const) : ('step' as const),
          waitingOn: reply ? (row.replyWatch?.senderEmails ?? []).slice(0, 3) : [],
        });
        if (watches.length >= LIST_LIMIT) break;
      }
      if (watches.length >= LIST_LIMIT) break;
    }
    return { routines, watches };
  },
});

/**
 * Pause or resume one routine the user agreed to. Consent stays "enabled": a
 * pause is not a refusal, and resume picks the next run from now.
 */
export const setRoutinePaused = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    routineId: v.string(),
    paused: v.boolean(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const routineId = ctx.db.normalizeId('albatrossRoutines', args.routineId);
    const routine = routineId ? await ctx.db.get(routineId) : null;
    if (!routine || routine.userId !== args.userId) throw new Error('Routine not found.');
    if (routine.consent !== 'enabled' || routine.status === 'archived')
      throw new Error('Only a routine you turned on can be paused or resumed.');
    const ts = now();
    if (args.paused) {
      await ctx.db.patch(routine._id, { status: 'paused', updatedAt: ts });
      return { paused: true, nextRunAt: null };
    }
    const nextRunAt = nextRoutineRunAt(routine, ts);
    if (nextRunAt === null) throw new Error('This routine has no valid next run. Edit its schedule first.');
    await ctx.db.patch(routine._id, { status: 'active', nextRunAt, updatedAt: ts });
    return { paused: false, nextRunAt };
  },
});

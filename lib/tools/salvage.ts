import { z } from 'zod';
import { api, convexQuery } from '@/lib/hosted/convex';
import { parseIsoInTimezone } from '@/lib/shared/timezones';
import { defineTool } from './registry';

// Salvage Today (issue #86/#17): one read-only tool that gathers everything
// still standing between the user and midnight — remaining calendar events,
// open tasks due today or overdue, active intents, and active projects — so
// the agent can propose a REALISTIC revised day instead of guessing from a
// broken plan.

const defaultDeps = {
  api,
  convexQuery,
  now: () => Date.now(),
};

let deps = defaultDeps;

export function __setSalvageToolDepsForTest(overrides: Partial<typeof defaultDeps> = {}) {
  deps = { ...defaultDeps, ...overrides };
}

function requireUserId(userId: string | null | undefined): string {
  if (!userId) throw new Error('Not authenticated.');
  return userId;
}

// How far back "overdue" reaches. Anything older than this is stale enough
// that it belongs to a review, not a same-day salvage.
const OVERDUE_LOOKBACK_MS = 60 * 86_400_000;

const EVENT_CAP = 25;
const TASK_CAP = 50;
const INTENT_CAP = 25;
const PROJECT_CAP = 25;

const ACTIVE_INTENT_STATUSES = new Set(['ready', 'needs_answers', 'planning']);

// End of the CURRENT day on the user's wall clock (not UTC). en-CA yields
// YYYY-MM-DD, which parseIsoInTimezone resolves in the same timezone.
export function endOfTodayMs(nowMs: number, timezone: string | undefined): number {
  const tz = timezone || 'UTC';
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
  return parseIsoInTimezone(`${day}T23:59:59`, tz, 'endOfToday');
}

function compactEvent(row: any) {
  return {
    eventId: row.providerEventId,
    accountId: row.accountId,
    calendarId: row.providerCalendarId,
    title: row.title,
    startIso: new Date(row.startAt).toISOString(),
    endIso: new Date(row.endAt).toISOString(),
    allDay: row.allDay,
    location: row.location,
    busy: row.busy,
    readOnly: row.readOnly,
  };
}

function compactTask(card: any, nowMs: number) {
  return {
    cardId: card.cardId,
    boardId: card.boardId,
    title: card.title,
    priority: card.priority,
    dueAt: card.dueAt,
    dueIso: typeof card.dueAt === 'number' ? new Date(card.dueAt).toISOString() : undefined,
    overdue: typeof card.dueAt === 'number' && card.dueAt < nowMs,
  };
}

function compactIntent(intent: any) {
  return {
    intentId: intent._id,
    title: intent.title || String(intent.rawText || '').slice(0, 120),
    status: intent.status,
    priority: intent.priority,
    areaId: intent.areaId,
  };
}

function compactProject(project: any) {
  return {
    projectId: project._id,
    title: project.title,
    outcome: typeof project.outcome === 'string' ? project.outcome.slice(0, 300) : undefined,
    status: project.status,
    areaId: project.areaId,
  };
}

export const salvageContext = defineTool({
  name: 'salvage_context',
  description:
    'Gather what is left of TODAY in one compact pack: remaining calendar events, open tasks due today or overdue, active intents, and active projects. Call this FIRST when the user is off track (woke up late, forgot something, day fell apart) before proposing a revised plan.',
  category: 'tasks',
  mutating: false,
  input: z.object({
    timezone: z
      .string()
      .optional()
      .describe('IANA timezone for "today". Defaults to the requesting user\'s timezone.'),
  }),
  output: z.object({
    now: z.string(),
    timezone: z.string(),
    events: z.array(z.any()),
    tasks: z.array(z.any()),
    intents: z.array(z.any()),
    projects: z.array(z.any()),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const timezone = args.timezone || ctx.userTimezone || 'UTC';
    const nowMs = deps.now();
    const endOfDay = endOfTodayMs(nowMs, timezone);
    const [eventRows, cardRows, intentRows, projectRows] = await Promise.all([
      deps.convexQuery<any[]>((deps.api as any).calendarData.listEvents, {
        userId,
        startAt: nowMs,
        endAt: endOfDay,
        limit: 100,
      }),
      deps.convexQuery<any[]>((deps.api as any).boards.listDueCards, {
        userId,
        startAt: nowMs - OVERDUE_LOOKBACK_MS,
        endAt: endOfDay,
      }),
      deps.convexQuery<any[]>((deps.api as any).albatrossIntents.listIntents, {
        userId,
        limit: 100,
      }),
      deps.convexQuery<any[]>((deps.api as any).albatrossWork.listProjects, {
        userId,
        status: 'active',
        limit: PROJECT_CAP,
      }),
    ]);
    return {
      now: new Date(nowMs).toISOString(),
      timezone,
      events: (eventRows || [])
        .filter((row) => row.status !== 'cancelled')
        .slice(0, EVENT_CAP)
        .map(compactEvent),
      tasks: (cardRows || [])
        .filter((card) => !card.completedAt)
        .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))
        .slice(0, TASK_CAP)
        .map((card) => compactTask(card, nowMs)),
      intents: (intentRows || [])
        .filter((intent) => ACTIVE_INTENT_STATUSES.has(intent.status))
        .slice(0, INTENT_CAP)
        .map(compactIntent),
      projects: (projectRows || []).slice(0, PROJECT_CAP).map(compactProject),
    };
  },
});

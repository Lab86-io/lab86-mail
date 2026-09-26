import { runWithAiRequestContext } from '@/lib/ai/context';
import { briefSourceHealth, loadBriefSourceRows } from '@/lib/brief/source-health';
import { api, convexQuery } from '@/lib/hosted/convex';
import type { DailyReport, DailyReportItem } from '@/lib/shared/types';
import { getLatestDailyReport } from '@/lib/store/daily-reports';
import { BriefEditionKindSchema, type TodaySummary, TodaySummarySchema } from './contract';

// The Today summary for widgets (FEATURES item 19). One read of the latest
// edition (with handled items dropped), the calendar from now, and the source
// health count. Native calls GET /api/mobile/v1/today/summary.

export const TODAY_SUMMARY_NO_EDITION = 'No brief yet today. It arrives at your delivery hour.';
export const TODAY_SUMMARY_READY = 'Your brief is ready.';

export interface TodaySummaryEvent {
  providerEventId?: string;
  accountId?: string;
  title?: string;
  startAt: number;
  endAt: number;
  allDay?: boolean;
  location?: string;
}

/** The first sentence of the text, cut at a word near `max`. */
export function firstSentence(text: string | null | undefined, max = 240): string {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const match = clean.match(/^.*?[.!?](?=\s|$)/);
  const sentence = match ? match[0] : clean;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function threadMove(item: DailyReportItem | undefined) {
  if (!item) return undefined;
  const detail = firstSentence(item.line || item.whyItMatters || '', 500);
  return {
    title: (item.subject || '(no subject)').slice(0, 500),
    ...(detail ? { detail } : {}),
    refKind: 'thread' as const,
    refID: item.threadId,
    accountID: item.account,
  };
}

export function buildTodaySummary(input: {
  report: DailyReport | null;
  events: TodaySummaryEvent[];
  attention: number;
  now: number;
}): TodaySummary {
  const { report, now } = input;
  const sections = report?.sections;
  const task = (sections?.tasks ?? [])
    .filter((row) => !row.completedAt && typeof row.dueAt === 'number')
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))[0];
  const nextMove =
    threadMove(sections?.answer?.[0]) ??
    threadMove(sections?.today?.[0]) ??
    (task ? { title: task.title.slice(0, 500), refKind: 'task' as const, refID: task.cardId } : undefined);
  const meeting = input.events
    .filter((event) => !event.allDay && event.endAt > now && event.providerEventId && event.title)
    .sort((a, b) => a.startAt - b.startAt)[0];
  const kind = BriefEditionKindSchema.safeParse(report?.kind);
  return TodaySummarySchema.parse({
    version: 1,
    ...(report ? { reportID: report._id } : {}),
    ...(kind.success ? { kind: kind.data } : {}),
    ...(report?.generatedAt ? { generatedAt: new Date(report.generatedAt).toISOString() } : {}),
    leadLine: report
      ? firstSentence(report.prose?.lede || report.narrative, 500) || TODAY_SUMMARY_READY
      : TODAY_SUMMARY_NO_EDITION,
    ...(nextMove ? { nextMove } : {}),
    ...(meeting
      ? {
          nextMeeting: {
            eventID: meeting.providerEventId,
            ...(meeting.accountId ? { accountID: meeting.accountId } : {}),
            title: String(meeting.title).slice(0, 500),
            startAt: new Date(meeting.startAt).toISOString(),
            endAt: new Date(meeting.endAt).toISOString(),
            ...(meeting.location ? { location: String(meeting.location).slice(0, 500) } : {}),
          },
        }
      : {}),
    sourcesNeedingAttention: Math.max(0, Math.floor(input.attention)),
    serverTime: new Date(now).toISOString(),
  });
}

const defaults = {
  latest: (userId: string) =>
    runWithAiRequestContext({ userId, agent: 'user' }, () => getLatestDailyReport(undefined, true)),
  events: (userId: string, now: number) =>
    convexQuery<TodaySummaryEvent[]>(api.calendarData.listEvents, {
      userId,
      // Four hours back keeps a meeting that is still running.
      startAt: now - 4 * 3600_000,
      endAt: now + 7 * 86_400_000,
      limit: 50,
    }),
  attention: async (userId: string) => briefSourceHealth(await loadBriefSourceRows(userId)).attention,
  now: () => Date.now(),
};

export async function loadTodaySummary(
  userId: string,
  overrides: Partial<typeof defaults> = {},
): Promise<TodaySummary> {
  const deps = { ...defaults, ...overrides };
  const now = deps.now();
  const [report, events, attention] = await Promise.all([
    deps.latest(userId),
    deps.events(userId, now).catch(() => [] as TodaySummaryEvent[]),
    deps.attention(userId).catch(() => 0),
  ]);
  return buildTodaySummary({ report, events: events || [], attention, now });
}

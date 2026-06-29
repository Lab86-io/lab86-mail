import { z } from 'zod';
import type { DailyReport, DailyReportCalendarItem, DailyReportItem, DailyReportTaskItem } from './types';

export const BRIEF_COMPOSITION_VERSION = 1;

export const BriefSourceRefSchema = z.object({
  kind: z.enum(['thread', 'message', 'task', 'event', 'mcp', 'account', 'derived']),
  id: z.string().min(1),
  account: z.string().optional(),
  label: z.string().optional(),
});

export const BriefActionSchema = z.object({
  action: z.enum([
    'open_thread',
    'open_view',
    'open_event',
    'resolve_thread',
    'dismiss_thread',
    'toggle_task',
    'dismiss_task',
    'create_task',
    'draft_reply',
    'archive_thread',
    'rsvp_event',
    'create_event',
  ]),
  label: z.string().min(1).max(80),
  payload: z.record(z.string(), z.unknown()).default({}),
  style: z.enum(['primary', 'secondary', 'danger', 'quiet']).default('secondary'),
});

export const BriefBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('lede'),
    title: z.string().max(120).optional(),
    paragraphs: z.array(z.string().min(1).max(1200)).min(1).max(4),
    sourceRefs: z.array(BriefSourceRefSchema).default([]),
  }),
  z.object({
    type: z.literal('needs_you'),
    title: z.string().max(80).default('Needs you'),
    items: z
      .array(
        z.object({
          account: z.string().min(1),
          threadId: z.string().min(1),
          subject: z.string().default('(no subject)'),
          person: z.string().default('Mail'),
          reason: z.string().min(1).max(700),
          lane: z.string().max(80).optional(),
          receivedAt: z.number().nullable().optional(),
          trackedThreadId: z.string().optional(),
          draftReply: z.string().max(4000).optional(),
          sourceRefs: z.array(BriefSourceRefSchema).default([]),
          actions: z.array(BriefActionSchema).default([]),
        }),
      )
      .max(12),
    sourceRefs: z.array(BriefSourceRefSchema).default([]),
  }),
  z.object({
    type: z.literal('task_digest'),
    title: z.string().max(80).default('Tasks'),
    tasks: z
      .array(
        z.object({
          cardId: z.string().min(1),
          title: z.string().min(1).max(500),
          meta: z.string().max(240).optional(),
          dueAt: z.number().nullable().optional(),
          sourceRefs: z.array(BriefSourceRefSchema).default([]),
          actions: z.array(BriefActionSchema).default([]),
        }),
      )
      .max(16),
    sourceRefs: z.array(BriefSourceRefSchema).default([]),
  }),
  z.object({
    type: z.literal('week_ahead'),
    title: z.string().max(80).default('The week ahead'),
    events: z
      .array(
        z.object({
          account: z.string().min(1),
          eventId: z.string().min(1),
          calendarId: z.string().nullable().optional(),
          title: z.string().min(1).max(300),
          startAt: z.number(),
          endAt: z.number(),
          allDay: z.boolean().optional(),
          location: z.string().nullable().optional(),
          prep: z.string().max(700).optional(),
          sourceRefs: z.array(BriefSourceRefSchema).default([]),
          actions: z.array(BriefActionSchema).default([]),
        }),
      )
      .max(20),
    sourceRefs: z.array(BriefSourceRefSchema).default([]),
  }),
  z.object({
    type: z.literal('tool_digest'),
    title: z.string().max(80).default('Across your tools'),
    items: z
      .array(
        z.object({
          server: z.enum(['github', 'bitbucket', 'jira', 'slack']),
          title: z.string().min(1).max(500),
          state: z.string().nullable().optional(),
          author: z.string().nullable().optional(),
          url: z.string().url().nullable().optional(),
          reason: z.string().max(700).optional(),
          sourceRefs: z.array(BriefSourceRefSchema).default([]),
          actions: z.array(BriefActionSchema).default([]),
        }),
      )
      .max(20),
    sourceRefs: z.array(BriefSourceRefSchema).default([]),
  }),
  z.object({
    type: z.literal('chart'),
    variant: z.enum(['bar', 'stacked_bar', 'donut']).default('bar'),
    title: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    data: z
      .array(
        z.object({
          label: z.string().min(1).max(80),
          value: z.number().nonnegative(),
          group: z.string().max(80).optional(),
        }),
      )
      .min(1)
      .max(12),
    sourceRefs: z.array(BriefSourceRefSchema).min(1),
  }),
  z.object({
    type: z.literal('timeline'),
    title: z.string().min(1).max(120),
    items: z
      .array(
        z.object({
          label: z.string().min(1).max(160),
          at: z.number().nullable().optional(),
          detail: z.string().max(500).optional(),
          sourceRefs: z.array(BriefSourceRefSchema).default([]),
        }),
      )
      .min(1)
      .max(16),
    sourceRefs: z.array(BriefSourceRefSchema).default([]),
  }),
  z.object({
    type: z.literal('prep_checklist'),
    title: z.string().min(1).max(120),
    items: z
      .array(
        z.object({
          label: z.string().min(1).max(240),
          detail: z.string().max(500).optional(),
          sourceRefs: z.array(BriefSourceRefSchema).default([]),
          action: BriefActionSchema.optional(),
        }),
      )
      .min(1)
      .max(12),
    sourceRefs: z.array(BriefSourceRefSchema).default([]),
  }),
  z.object({
    type: z.literal('custom_widget'),
    id: z.string().min(1).max(80),
    title: z.string().min(1).max(120),
    html: z.string().min(1).max(20_000),
    fallbackMarkdown: z.string().min(1).max(2000),
    allowedActions: z.array(BriefActionSchema.shape.action).max(8).default([]),
    sourceRefs: z.array(BriefSourceRefSchema).min(1),
  }),
]);

export const BriefCompositionSchema = z.object({
  version: z.literal(BRIEF_COMPOSITION_VERSION),
  title: z.string().min(1).max(160),
  summary: z.string().max(1000).optional(),
  services: z.array(z.string().min(1)).default([]),
  blocks: z.array(BriefBlockSchema).min(1).max(16),
});

export type BriefSourceRef = z.infer<typeof BriefSourceRefSchema>;
export type BriefAction = z.infer<typeof BriefActionSchema>;
export type BriefBlock = z.infer<typeof BriefBlockSchema>;
export type BriefComposition = z.infer<typeof BriefCompositionSchema>;
type BriefLaneItem = Omit<DailyReportItem, 'lane'> & { lane: string };

export function parseBriefComposition(value: unknown): BriefComposition {
  return BriefCompositionSchema.parse(value);
}

export function extractBriefCompositionJson(raw: string): unknown {
  let text = String(raw || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('brief composition JSON not found');
  return JSON.parse(text.slice(start, end + 1));
}

export function compositionFromReport(report: DailyReport): BriefComposition {
  const sections = (report.sections || {}) as Partial<DailyReport['sections']>;
  const needs = [
    ...withLane(sections.replyOwed || [], 'Reply owed'),
    ...withLane(sections.followUpOwed || [], 'Follow-up'),
    ...withLane(sections.timeSensitive || [], 'Time-sensitive'),
    ...withLane(sections.newPeople || [], 'New person'),
    ...withLane(sections.tracked || [], 'Tracked'),
  ].slice(0, 8);
  const tasks = (sections.tasks || []).filter((task) => !task.completedAt).slice(0, 8);
  const events = (sections.calendar || [])
    .slice()
    .sort((a, b) => Number(a.startAt || 0) - Number(b.startAt || 0))
    .slice(0, 12);
  const mcp = (sections.mcp || []).slice(0, 12);
  const blocks: BriefBlock[] = [
    {
      type: 'lede',
      paragraphs: ledeParagraphs(report.narrative || fallbackNarrative(needs, tasks, events)),
      sourceRefs: [],
    },
    {
      type: 'needs_you',
      title: 'Needs you',
      items: needs.map((item) => threadItemToComposition(item)),
      sourceRefs: needs.map((item) => threadSourceRef(item)),
    },
    {
      type: 'task_digest',
      title: 'Tasks',
      tasks: tasks.map((task) => taskToComposition(task)),
      sourceRefs: tasks.map((task) => ({ kind: 'task', id: task.cardId }) as BriefSourceRef),
    },
    {
      type: 'week_ahead',
      title: 'The week ahead',
      events: events.map((event) => eventToComposition(event)),
      sourceRefs: events.map(
        (event) => ({ kind: 'event', id: event.eventId, account: event.account }) as BriefSourceRef,
      ),
    },
  ];
  if (mcp.length) {
    blocks.push({
      type: 'tool_digest',
      title: 'Across your tools',
      items: mcp.map((item) => ({
        server: item.server,
        title: item.title,
        state: item.state ?? null,
        author: item.author ?? null,
        url: item.url ?? null,
        sourceRefs: [{ kind: 'mcp', id: `${item.server}:${item.kind}:${item.title}` }],
        actions: item.url
          ? [
              {
                action: 'open_view',
                label: 'Open tools',
                payload: { view: 'mail' },
                style: 'quiet',
              },
            ]
          : [],
      })),
      sourceRefs: mcp.map(
        (item) => ({ kind: 'mcp', id: `${item.server}:${item.kind}:${item.title}` }) as BriefSourceRef,
      ),
    });
  }
  return {
    version: BRIEF_COMPOSITION_VERSION,
    title: report.title || 'Daily Brief',
    summary: report.narrative,
    services: report.services || [],
    blocks,
  };
}

function withLane(items: DailyReportItem[], lane: string): BriefLaneItem[] {
  return items.map((item) => ({ ...item, lane }));
}

function threadItemToComposition(item: BriefLaneItem) {
  return {
    account: item.account,
    threadId: item.threadId,
    subject: item.subject || '(no subject)',
    person: item.people?.[0] || 'Mail',
    reason: item.whyItMatters || item.nextAction || 'Review this thread when you have a moment.',
    lane: item.lane,
    receivedAt: item.receivedAt ?? null,
    trackedThreadId: item.trackedThreadId,
    sourceRefs: [threadSourceRef(item)],
    actions: [
      {
        action: 'open_thread',
        label: 'Open',
        payload: { account: item.account, threadId: item.threadId },
        style: 'primary',
      },
      {
        action: 'resolve_thread',
        label: 'Done',
        payload: threadPayload(item),
        style: 'quiet',
      },
      {
        action: 'dismiss_thread',
        label: 'Remove',
        payload: threadPayload(item),
        style: 'quiet',
      },
    ],
  } satisfies Extract<BriefBlock, { type: 'needs_you' }>['items'][number];
}

function taskToComposition(task: DailyReportTaskItem) {
  return {
    cardId: task.cardId,
    title: task.title,
    meta: [task.boardTitle, task.columnName].filter(Boolean).join(' - '),
    dueAt: task.dueAt ?? null,
    sourceRefs: [{ kind: 'task', id: task.cardId }],
    actions: [
      {
        action: 'toggle_task',
        label: 'Complete',
        payload: { cardId: task.cardId, completed: true, title: task.title },
        style: 'quiet',
      },
      {
        action: 'dismiss_task',
        label: 'Remove',
        payload: { cardId: task.cardId, title: task.title },
        style: 'quiet',
      },
    ],
  } satisfies Extract<BriefBlock, { type: 'task_digest' }>['tasks'][number];
}

function eventToComposition(event: DailyReportCalendarItem) {
  return {
    account: event.account,
    eventId: event.eventId,
    calendarId: event.calendarId ?? null,
    title: event.title,
    startAt: event.startAt,
    endAt: event.endAt,
    allDay: event.allDay ?? false,
    location: event.location ?? null,
    sourceRefs: [{ kind: 'event', id: event.eventId, account: event.account }],
    actions: [
      {
        action: 'open_event',
        label: 'Open',
        payload: { account: event.account, eventId: event.eventId },
        style: 'secondary',
      },
    ],
  } satisfies Extract<BriefBlock, { type: 'week_ahead' }>['events'][number];
}

function threadSourceRef(item: { account: string; threadId: string; subject?: string }): BriefSourceRef {
  return { kind: 'thread', id: item.threadId, account: item.account, label: item.subject };
}

function threadPayload(item: {
  account: string;
  threadId: string;
  subject?: string;
  receivedAt?: number | null;
  trackedThreadId?: string;
}) {
  return {
    account: item.account,
    threadId: item.threadId,
    subject: item.subject,
    receivedAt: item.receivedAt ?? null,
    trackedThreadId: item.trackedThreadId,
  };
}

function fallbackNarrative(
  needs: BriefLaneItem[],
  tasks: DailyReportTaskItem[],
  events: DailyReportCalendarItem[],
) {
  const parts = [];
  if (needs.length) parts.push(`${needs.length} thread${needs.length === 1 ? '' : 's'} need attention`);
  if (events.length)
    parts.push(`${events.length} calendar item${events.length === 1 ? '' : 's'} shape the week`);
  if (tasks.length) parts.push(`${tasks.length} task${tasks.length === 1 ? '' : 's'} are active`);
  return parts.length
    ? `Here is the shape of the day: ${parts.join(', ')}.`
    : 'A quiet brief today: nothing urgent is waiting.';
}

function ledeParagraphs(value: string): string[] {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return ['A quiet brief today: nothing urgent is waiting.'];
  const explicit = String(value)
    .split(/\n{2,}/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (explicit.length > 1) return explicit.slice(0, 4);
  const sentences = normalized.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)?.map((part) => part.trim()) || [
    normalized,
  ];
  if (sentences.length < 3) return [normalized];
  const first = Math.ceil(sentences.length / 2);
  return [sentences.slice(0, first).join(' '), sentences.slice(first).join(' ')].filter(Boolean);
}

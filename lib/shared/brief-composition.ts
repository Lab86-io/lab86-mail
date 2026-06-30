import { z } from 'zod';
import type { DailyReport, DailyReportCalendarItem, DailyReportItem, DailyReportTaskItem } from './types';

export const BRIEF_COMPOSITION_VERSION = 1;

const BRIEF_SOURCE_REF_KINDS = ['thread', 'message', 'task', 'event', 'mcp', 'account', 'derived'] as const;
const BRIEF_ACTION_TYPES = [
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
] as const;
const BRIEF_ACTION_STYLES = ['primary', 'secondary', 'danger', 'quiet'] as const;
const MAX_LEDE_PARAGRAPH_CHARS = 1200;
const MAX_LEDE_PARAGRAPHS = 4;
const DEFAULT_LEDE = 'A quiet brief today: nothing urgent is waiting.';

export const BriefSourceRefSchema = z.object({
  kind: z.enum(BRIEF_SOURCE_REF_KINDS),
  id: z.string().min(1),
  account: z.string().optional(),
  label: z.string().optional(),
});

export const BriefActionSchema = z.object({
  action: z.enum(BRIEF_ACTION_TYPES),
  label: z.string().min(1).max(80),
  payload: z.record(z.string(), z.unknown()).default({}),
  style: z.enum(BRIEF_ACTION_STYLES).default('secondary'),
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
  const parsed = BriefCompositionSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return BriefCompositionSchema.parse(repairBriefComposition(value));
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

function repairBriefComposition(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const composition = repairNestedCompositionValue(value) as Record<string, unknown>;
  if (!Array.isArray(composition.blocks)) return composition;
  composition.blocks = composition.blocks.map((block, index) => {
    const repaired = repairNestedCompositionValue(block) as Record<string, unknown>;
    if (repaired.type === 'lede') {
      repaired.paragraphs = normalizeLedeParagraphsInput(repaired.paragraphs);
    }
    if (
      (repaired.type === 'chart' || repaired.type === 'custom_widget') &&
      (!Array.isArray(repaired.sourceRefs) || !repaired.sourceRefs.length)
    ) {
      repaired.sourceRefs = [{ kind: 'derived', id: `block:${String(repaired.type)}:${index}` }];
    }
    return repaired;
  });
  return composition;
}

function repairNestedCompositionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(repairNestedCompositionValue);
  if (!isRecord(value)) return value;

  const repaired: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'sourceRefs') {
      repaired[key] = sanitizeSourceRefs(entry);
    } else if (key === 'actions') {
      repaired[key] = sanitizeActions(entry);
    } else if (key === 'action' && isRecord(entry)) {
      const [action] = sanitizeActions([entry]);
      if (action) repaired[key] = action;
    } else if (key === 'allowedActions') {
      repaired[key] = sanitizeAllowedActions(entry);
    } else {
      repaired[key] = repairNestedCompositionValue(entry);
    }
  }
  return repaired;
}

function sanitizeSourceRefs(value: unknown): BriefSourceRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = firstString(
      entry.id,
      entry.threadId,
      entry.messageId,
      entry.cardId,
      entry.eventId,
      entry.account,
    );
    if (!id) return [];
    const ref: BriefSourceRef = {
      kind: sourceRefKind(entry.kind, entry),
      id,
    };
    const account = firstString(entry.account);
    const label = firstString(entry.label, entry.subject, entry.title);
    if (account) ref.account = account;
    if (label) ref.label = label;
    return [ref];
  });
}

function sourceRefKind(value: unknown, entry: Record<string, unknown>): BriefSourceRef['kind'] {
  if (isOneOf(value, BRIEF_SOURCE_REF_KINDS)) return value;
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (text.includes('message')) return 'message';
  if (text.includes('thread') || text.includes('mail') || text.includes('email')) return 'thread';
  if (text.includes('task') || text.includes('todo')) return 'task';
  if (text.includes('event') || text.includes('calendar')) return 'event';
  if (text.includes('account')) return 'account';
  if (entry.threadId) return 'thread';
  if (entry.messageId) return 'message';
  if (entry.cardId) return 'task';
  if (entry.eventId) return 'event';
  return 'derived';
}

function sanitizeActions(value: unknown): BriefAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || !isOneOf(entry.action, BRIEF_ACTION_TYPES)) return [];
    const label = firstString(entry.label) || defaultActionLabel(entry.action);
    const payload = isRecord(entry.payload) ? entry.payload : {};
    const style = isOneOf(entry.style, BRIEF_ACTION_STYLES) ? entry.style : 'secondary';
    return [
      {
        action: entry.action,
        label: label.slice(0, 80),
        payload,
        style,
      },
    ];
  });
}

function sanitizeAllowedActions(value: unknown): BriefAction['action'][] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is BriefAction['action'] => isOneOf(entry, BRIEF_ACTION_TYPES));
}

function defaultActionLabel(action: BriefAction['action']): string {
  switch (action) {
    case 'open_thread':
    case 'open_event':
    case 'open_view':
      return 'Open';
    case 'resolve_thread':
      return 'Done';
    case 'dismiss_thread':
    case 'dismiss_task':
      return 'Remove';
    case 'toggle_task':
      return 'Complete';
    case 'create_task':
      return 'Create task';
    case 'draft_reply':
      return 'Draft reply';
    case 'archive_thread':
      return 'Archive';
    case 'rsvp_event':
      return 'RSVP';
    case 'create_event':
      return 'Create event';
  }
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isOneOf<const T extends readonly string[]>(value: unknown, options: T): value is T[number] {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
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
  const raw = String(value || '').trim();
  if (/^\s{0,3}#{1,3}\s+\S/m.test(raw) || /^\s*[-*]\s+\S/m.test(raw)) {
    return schemaSafeLedeParagraphs(markdownLedeParts(raw));
  }
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return [DEFAULT_LEDE];
  const explicit = String(value)
    .split(/\n{2,}/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (explicit.length > 1) return schemaSafeLedeParagraphs(explicit);
  const sentences = normalized.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)?.map((part) => part.trim()) || [
    normalized,
  ];
  if (sentences.length < 3) return schemaSafeLedeParagraphs([normalized]);
  const first = Math.ceil(sentences.length / 2);
  return schemaSafeLedeParagraphs([sentences.slice(0, first).join(' '), sentences.slice(first).join(' ')]);
}

function normalizeLedeParagraphsInput(value: unknown): string[] {
  const paragraphs = Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === 'string' ? [entry] : []))
    : typeof value === 'string'
      ? [value]
      : [];
  return schemaSafeLedeParagraphs(paragraphs.length ? paragraphs : [DEFAULT_LEDE]);
}

function markdownLedeParts(raw: string): string[] {
  const parts = raw
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [raw];
}

function schemaSafeLedeParagraphs(parts: string[]): string[] {
  const paragraphs: string[] = [];
  for (const part of parts) {
    for (const chunk of splitLedeChunk(part)) {
      if (!chunk) continue;
      paragraphs.push(chunk);
      if (paragraphs.length >= MAX_LEDE_PARAGRAPHS) return paragraphs;
    }
  }
  return paragraphs.length ? paragraphs : [DEFAULT_LEDE];
}

function splitLedeChunk(value: string): string[] {
  const text = value.replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  if (text.length <= MAX_LEDE_PARAGRAPH_CHARS) return [text];
  if (!text.includes('\n')) return splitLedeText(text);

  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    for (const lineChunk of splitLedeText(line.trimEnd())) {
      const next = current ? `${current}\n${lineChunk}` : lineChunk;
      if (current && next.length > MAX_LEDE_PARAGRAPH_CHARS) {
        chunks.push(current);
        current = lineChunk;
      } else {
        current = next;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLedeText(value: string): string[] {
  const text = value.trim();
  if (!text) return [];
  const units = text
    .match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)
    ?.map((part) => part.trim())
    .filter(Boolean) || [text];
  return packLedeUnits(units);
}

function packLedeUnits(units: string[]): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    const pieces = unit.length > MAX_LEDE_PARAGRAPH_CHARS ? splitLongLedeUnit(unit) : [unit];
    for (const piece of pieces) {
      const next = current ? `${current} ${piece}` : piece;
      if (current && next.length > MAX_LEDE_PARAGRAPH_CHARS) {
        chunks.push(current);
        current = piece;
      } else {
        current = next;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLongLedeUnit(value: string): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const word of value.split(/\s+/).filter(Boolean)) {
    if (word.length > MAX_LEDE_PARAGRAPH_CHARS) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let index = 0; index < word.length; index += MAX_LEDE_PARAGRAPH_CHARS) {
        chunks.push(word.slice(index, index + MAX_LEDE_PARAGRAPH_CHARS));
      }
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (current && next.length > MAX_LEDE_PARAGRAPH_CHARS) {
      chunks.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
